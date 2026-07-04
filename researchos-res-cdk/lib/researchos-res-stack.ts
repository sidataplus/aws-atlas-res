import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3_assets from 'aws-cdk-lib/aws-s3-assets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

function ctx(scope: Construct, key: string, fallback?: string): string | undefined {
  const value = scope.node.tryGetContext(key);
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return String(value);
}

function boolCtx(scope: Construct, key: string, fallback = false): boolean {
  const value = ctx(scope, key);
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'y'].includes(value.toLowerCase());
}

function resBool(value: boolean): string {
  return value ? 'True' : 'False';
}

function csv(scope: Construct, key: string, fallback: string[] = []): string[] {
  const value = ctx(scope, key);
  if (!value) return fallback;
  return value.split(',').map(v => v.trim()).filter(Boolean);
}

function maybePut(parameters: Record<string, string>, key: string, value?: string) {
  if (value !== undefined && value !== '') {
    parameters[key] = value;
  }
}

function put(parameters: Record<string, string>, key: string, value?: string) {
  parameters[key] = value ?? '';
}

function cfnParamString(scope: cdk.Stack, id: string, description: string, defaultValue?: string): string {
  const param = new cdk.CfnParameter(scope, id, {
    type: 'String',
    description,
    default: defaultValue
  });
  return param.valueAsString;
}

export class ResearchOsResStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const deployRes = boolCtx(this, 'deployRes', true);
    const createVpc = boolCtx(this, 'createVpc', false);
    const createEfs = boolCtx(this, 'createEfs', true);
    const createEfsMountTargets = boolCtx(this, 'createEfsMountTargets', false);
    const ssmPrefix = ctx(this, 'ssmPrefix', '/researchos/shared')!;

    const region = Stack.of(this).region;
    const account = Stack.of(this).account;
    const partition = Stack.of(this).partition;

    const resEnvironmentName = ctx(this, 'resEnvironmentName', 'res-ohdsi')!;
    const configuredResTemplateUrl = ctx(
      this,
      'resTemplateUrl',
      'https://research-engineering-studio-us-east-1.s3.amazonaws.com/releases/latest/ResearchAndEngineeringStudio.template.json'
    )!;
    const resTemplatePath = ctx(this, 'resTemplatePath');
    const resTemplateAsset = resTemplatePath
      ? new s3_assets.Asset(this, 'ResearchEngineeringStudioTemplateAsset', {
          path: path.resolve(resTemplatePath)
        })
      : undefined;
    const resTemplateUrl = resTemplateAsset?.httpUrl ?? configuredResTemplateUrl;

    const administratorEmail =
      ctx(this, 'administratorEmail') ??
      cfnParamString(this, 'ResAdministratorEmail', 'Break-glass/admin email for RES');

    const sshKeyPair =
      ctx(this, 'sshKeyPair') ??
      cfnParamString(this, 'ResSshKeyPair', 'Existing EC2 key pair name for RES infrastructure hosts');

    const clientIp = ctx(this, 'clientIp', '0.0.0.0/0')!;
    const customDomainNameForWebApp = ctx(this, 'customDomainNameForWebApp', '');
    const clusterManagerExternalTargetGroupName = ctx(
      this,
      'clusterManagerExternalTargetGroupName',
      `${resEnvironmentName}-cm-ext-ae72f4e0`
    )!;
    const hostedZoneId = ctx(this, 'customDomainHostedZoneId') ?? ctx(this, 'hostedZoneId');
    const hostedZoneName = ctx(this, 'customDomainHostedZoneName') ?? ctx(this, 'hostedZoneName');
    let acmCertificateArnForWebApp = ctx(this, 'acmCertificateArnForWebApp', '');
    let webAppHostedZone: route53.IHostedZone | undefined;

    if (customDomainNameForWebApp && hostedZoneId && hostedZoneName) {
      webAppHostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'WebAppHostedZone', {
        hostedZoneId,
        zoneName: hostedZoneName
      });

      if (!acmCertificateArnForWebApp) {
        const webAppCertificate = new acm.Certificate(this, 'ResWebAppCertificate', {
          domainName: customDomainNameForWebApp,
          validation: acm.CertificateValidation.fromDns(webAppHostedZone)
        });
        acmCertificateArnForWebApp = webAppCertificate.certificateArn;
      }
    } else if (customDomainNameForWebApp && !acmCertificateArnForWebApp) {
      throw new Error(
        'customDomainNameForWebApp requires acmCertificateArnForWebApp, or hostedZoneId and hostedZoneName so the wrapper can create one.'
      );
    }

    let vpc: ec2.IVpc;
    let publicSubnetIds: string[] = [];
    let privateSubnetIds: string[] = [];
    let vpcId: string;
    let vpcCidr = ctx(this, 'vpcCidr', '10.0.0.0/16')!;

    if (createVpc) {
      const createdVpc = new ec2.Vpc(this, 'ResVpc', {
        maxAzs: 2,
        natGateways: Number(ctx(this, 'natGateways', '1')),
        subnetConfiguration: [
          {
            name: 'public',
            subnetType: ec2.SubnetType.PUBLIC,
            cidrMask: 24
          },
          {
            name: 'private-egress',
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
            cidrMask: 24
          }
        ]
      });

      vpc = createdVpc;
      vpcId = createdVpc.vpcId;
      publicSubnetIds = createdVpc.publicSubnets.map(s => s.subnetId);
      privateSubnetIds = createdVpc.privateSubnets.map(s => s.subnetId);
    } else {
      vpcId =
        ctx(this, 'vpcId') ??
        cfnParamString(this, 'SharedVpcId', 'Existing VPC ID, ideally from the ATLAS/WebAPI stack');

      publicSubnetIds = csv(this, 'publicSubnetIds');
      privateSubnetIds = csv(this, 'privateSubnetIds');

      if (publicSubnetIds.length < 2 && deployRes) {
        publicSubnetIds = csv(this, 'loadBalancerSubnetIds');
      }

      if (privateSubnetIds.length < 2 && deployRes) {
        privateSubnetIds = csv(this, 'infrastructureHostSubnetIds');
      }

      const availabilityZones = csv(this, 'availabilityZones', [
        `${region}a`,
        `${region}b`
      ]);

      vpc = ec2.Vpc.fromVpcAttributes(this, 'ImportedSharedVpc', {
        vpcId,
        availabilityZones,
        publicSubnetIds: publicSubnetIds.length > 0 ? publicSubnetIds : undefined,
        privateSubnetIds: privateSubnetIds.length > 0 ? privateSubnetIds : undefined
      });
    }

    const loadBalancerSubnetIds = csv(this, 'loadBalancerSubnetIds', publicSubnetIds);
    const infrastructureHostSubnetIds = csv(this, 'infrastructureHostSubnetIds', privateSubnetIds);
    const vdiSubnetIds = csv(this, 'vdiSubnetIds', privateSubnetIds);

    let sharedHomeFilesystemId = ctx(this, 'efsFileSystemId');

    if (!sharedHomeFilesystemId && createEfs) {
      const efsSecurityGroup = new ec2.SecurityGroup(this, 'ResSharedHomeEfsSecurityGroup', {
        vpc,
        description: 'Allows RES Linux VDI/infrastructure hosts to mount shared home EFS',
        allowAllOutbound: true
      });

      efsSecurityGroup.addIngressRule(
        ec2.Peer.ipv4(vpcCidr),
        ec2.Port.tcp(2049),
        'NFS from shared VPC CIDR'
      );

      const efsSubnets = infrastructureHostSubnetIds.length > 0
        ? infrastructureHostSubnetIds.map((subnetId, index) =>
            ec2.Subnet.fromSubnetId(this, `ImportedEfsSubnet${index}`, subnetId)
          )
        : undefined;

      const fs = new efs.FileSystem(this, 'ResSharedHomeFileSystem', {
        vpc,
        encrypted: true,
        enableAutomaticBackups: true,
        lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS,
        performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
        throughputMode: efs.ThroughputMode.ELASTIC,
        securityGroup: efsSecurityGroup,
        vpcSubnets: efsSubnets ? { subnets: efsSubnets } : undefined,
        removalPolicy: boolCtx(this, 'destroyEfsOnStackDelete', false)
          ? RemovalPolicy.DESTROY
          : RemovalPolicy.RETAIN
      });

      sharedHomeFilesystemId = fs.fileSystemId;

    } else if (sharedHomeFilesystemId && createEfsMountTargets) {
      if (infrastructureHostSubnetIds.length === 0) {
        throw new Error('createEfsMountTargets=true requires infrastructureHostSubnetIds or privateSubnetIds.');
      }

      const efsSecurityGroup = new ec2.SecurityGroup(this, 'ResSharedHomeEfsSecurityGroup', {
        vpc,
        description: 'Allows RES Linux VDI/infrastructure hosts to mount existing shared home EFS',
        allowAllOutbound: true
      });

      efsSecurityGroup.addIngressRule(
        ec2.Peer.ipv4(vpcCidr),
        ec2.Port.tcp(2049),
        'NFS from shared VPC CIDR'
      );

      const existingSharedHomeFilesystemId = sharedHomeFilesystemId;

      infrastructureHostSubnetIds.forEach((subnetId, index) => {
        new efs.CfnMountTarget(this, `ResSharedHomeFileSystemMountTarget${index + 1}`, {
          fileSystemId: existingSharedHomeFilesystemId,
          subnetId,
          securityGroups: [efsSecurityGroup.securityGroupId]
        });
      });
    }

    if (sharedHomeFilesystemId) {
      new CfnOutput(this, 'ResSharedHomeFileSystemId', {
        value: sharedHomeFilesystemId
      });
    }

    const cognitoUserPoolId = ctx(this, 'cognitoUserPoolId');
    const cognitoDomainPrefix = ctx(this, 'cognitoDomainPrefix');
    const cognitoUserPoolDomainUrl =
      ctx(this, 'cognitoUserPoolDomainUrl') ??
      (cognitoDomainPrefix
        ? `https://${cognitoDomainPrefix}.auth.${region}.amazoncognito.com`
        : undefined);

    let cognitoPrepResource: cdk.CustomResource | undefined;

    if (cognitoUserPoolId) {
      const onEventHandler = new lambda.Function(this, 'EnsureResCognitoSchemaHandler', {
        runtime: lambda.Runtime.PYTHON_3_12,
        handler: 'index.on_event',
        timeout: Duration.minutes(5),
        code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'cognito-res-schema')),
        logRetention: logs.RetentionDays.ONE_MONTH
      });

      onEventHandler.addToRolePolicy(new iam.PolicyStatement({
        actions: [
          'cognito-idp:DescribeUserPool',
          'cognito-idp:AddCustomAttributes',
          'cognito-idp:GetGroup',
          'cognito-idp:CreateGroup'
        ],
        resources: [
          `arn:${partition}:cognito-idp:${region}:${account}:userpool/${cognitoUserPoolId}`
        ]
      }));

      const provider = new cr.Provider(this, 'EnsureResCognitoSchemaProvider', {
        onEventHandler,
        logRetention: logs.RetentionDays.ONE_MONTH
      });

      cognitoPrepResource = new cdk.CustomResource(this, 'EnsureResCognitoSchema', {
        serviceToken: provider.serviceToken,
        properties: {
          UserPoolId: cognitoUserPoolId,
          Groups: csv(this, 'cognitoGroups', ['admins', 'atlas', 'res'])
        }
      });

      new CfnOutput(this, 'SharedCognitoUserPoolId', {
        value: cognitoUserPoolId
      });

      if (cognitoUserPoolDomainUrl) {
        new CfnOutput(this, 'SharedCognitoUserPoolDomainUrl', {
          value: cognitoUserPoolDomainUrl
        });
      }

      cognito.UserPool.fromUserPoolId(this, 'ImportedAtlasCognitoUserPool', cognitoUserPoolId);
    }

    const atlasUrl = ctx(this, 'atlasUrl', '')!;
    const webApiUrl = ctx(this, 'webApiUrl', '')!;
    const omopDbEndpoint = ctx(this, 'omopDbEndpoint', '')!;
    const webDbEndpoint = ctx(this, 'webDbEndpoint', '')!;
    const omopDbSecretArn = ctx(this, 'omopDbSecretArn', '')!;
    const webDbSecretArn = ctx(this, 'webDbSecretArn', '')!;
    const synpufS3Uri = ctx(this, 'synpufS3Uri', 's3://synpuf-omop/')!;
    const cdmSchema = ctx(this, 'cdmSchema', 'cdm_synpuf')!;
    const resultsSchema = ctx(this, 'resultsSchema', 'results_synpuf')!;
    const tempSchema = ctx(this, 'tempSchema', 'temp_synpuf')!;

    const sharedCatalogSecret = new secretsmanager.Secret(this, 'ResearchOsSharedDataCatalogSecret', {
      description: 'Shared metadata allowing RES VDIs to discover OHDSI ATLAS/WebAPI/OMOP resources',
      secretObjectValue: {
        atlasUrl: cdk.SecretValue.unsafePlainText(atlasUrl),
        webApiUrl: cdk.SecretValue.unsafePlainText(webApiUrl),
        omopDbEndpoint: cdk.SecretValue.unsafePlainText(omopDbEndpoint),
        webDbEndpoint: cdk.SecretValue.unsafePlainText(webDbEndpoint),
        omopDbSecretArn: cdk.SecretValue.unsafePlainText(omopDbSecretArn),
        webDbSecretArn: cdk.SecretValue.unsafePlainText(webDbSecretArn),
        synpufS3Uri: cdk.SecretValue.unsafePlainText(synpufS3Uri),
        cdmSchema: cdk.SecretValue.unsafePlainText(cdmSchema),
        resultsSchema: cdk.SecretValue.unsafePlainText(resultsSchema),
        tempSchema: cdk.SecretValue.unsafePlainText(tempSchema),
        cognitoUserPoolId: cdk.SecretValue.unsafePlainText(cognitoUserPoolId ?? ''),
        resEnvironmentName: cdk.SecretValue.unsafePlainText(resEnvironmentName)
      }
    });

    const atlasUrlParam = new ssm.StringParameter(this, 'AtlasUrlParameter', {
      parameterName: `${ssmPrefix}/atlas/url`,
      stringValue: atlasUrl || 'unset'
    });

    const webApiUrlParam = new ssm.StringParameter(this, 'WebApiUrlParameter', {
      parameterName: `${ssmPrefix}/webapi/url`,
      stringValue: webApiUrl || 'unset'
    });

    const omopEndpointParam = new ssm.StringParameter(this, 'OmopEndpointParameter', {
      parameterName: `${ssmPrefix}/omop/endpoint`,
      stringValue: omopDbEndpoint || 'unset'
    });

    const omopSchemasParam = new ssm.StringParameter(this, 'OmopSchemasParameter', {
      parameterName: `${ssmPrefix}/omop/schemas`,
      stringValue: JSON.stringify({
        cdmSchema,
        resultsSchema,
        tempSchema
      })
    });

    const bootstrapAsset = new s3_assets.Asset(this, 'LinuxVdiOhdsiProfileAsset', {
      path: path.join(__dirname, '..', 'bootstrap', 'linux-vdi', 'ohdsi_profile.sh')
    });

    const dataAccessPolicy = new iam.ManagedPolicy(this, 'ResOhdsiDataAccessPolicy', {
      description: 'Attach to RES project/VDI roles that need read-only discovery of OHDSI ATLAS/WebAPI/OMOP resources'
    });

    dataAccessPolicy.addStatements(
      new iam.PolicyStatement({
        actions: [
          'ssm:GetParameter',
          'ssm:GetParameters',
          'ssm:GetParametersByPath'
        ],
        resources: [
          atlasUrlParam.parameterArn,
          webApiUrlParam.parameterArn,
          omopEndpointParam.parameterArn,
          omopSchemasParam.parameterArn,
          `arn:${partition}:ssm:${region}:${account}:parameter${ssmPrefix}/*`
        ]
      }),
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          sharedCatalogSecret.secretArn,
          ...(omopDbSecretArn ? [omopDbSecretArn] : []),
          ...(webDbSecretArn ? [webDbSecretArn] : [])
        ]
      }),
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [
          bootstrapAsset.s3ObjectUrl.replace('s3://', 'arn:aws:s3:::')
        ]
      }),
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [
          `${bootstrapAsset.bucket.bucketArn}/${bootstrapAsset.s3ObjectKey}`
        ]
      }),
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [
          bootstrapAsset.bucket.bucketArn
        ]
      })
    );

    if (synpufS3Uri.startsWith('s3://')) {
      const noScheme = synpufS3Uri.replace('s3://', '').replace(/\/$/, '');
      const bucketName = noScheme.split('/')[0];
      const prefix = noScheme.split('/').slice(1).join('/');

      dataAccessPolicy.addStatements(
        new iam.PolicyStatement({
          actions: ['s3:ListBucket'],
          resources: [`arn:${partition}:s3:::${bucketName}`],
          conditions: prefix ? { StringLike: { 's3:prefix': [`${prefix}/*`, prefix] } } : undefined
        }),
        new iam.PolicyStatement({
          actions: ['s3:GetObject'],
          resources: [`arn:${partition}:s3:::${bucketName}/${prefix ? `${prefix}/*` : '*'}`]
        })
      );
    }

    const dataClientSecurityGroup = new ec2.SecurityGroup(this, 'ResDataClientSecurityGroup', {
      vpc,
      description: 'Optional SG to attach to RES VDIs/projects for OHDSI OMOP database access',
      allowAllOutbound: true
    });

    const omopDbSecurityGroupId = ctx(this, 'omopDbSecurityGroupId');
    if (omopDbSecurityGroupId) {
      const omopDbSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
        this,
        'ImportedOmopDbSecurityGroup',
        omopDbSecurityGroupId,
        { mutable: true }
      );

      omopDbSecurityGroup.addIngressRule(
        dataClientSecurityGroup,
        ec2.Port.tcp(Number(ctx(this, 'omopDbPort', '5432'))),
        'Allow RES data client SG to connect to OMOP database'
      );

      if (boolCtx(this, 'allowOmopDbFromVpcCidr', false)) {
        omopDbSecurityGroup.addIngressRule(
          ec2.Peer.ipv4(vpcCidr),
          ec2.Port.tcp(Number(ctx(this, 'omopDbPort', '5432'))),
          'Allow RES/ATLAS shared VPC CIDR to connect to OMOP database'
        );
      }
    }

    const parameters: Record<string, string> = {};

    put(parameters, 'EnvironmentName', resEnvironmentName);
    put(parameters, 'AdministratorEmail', administratorEmail);
    put(parameters, 'InfrastructureHostAMI', ctx(this, 'infrastructureHostAmi', ''));
    put(parameters, 'SSHKeyPair', sshKeyPair);
    put(parameters, 'ClientIp', clientIp);
    put(parameters, 'ClientPrefixList', ctx(this, 'clientPrefixList', ''));
    put(parameters, 'IAMPermissionBoundary', ctx(this, 'iamPermissionBoundary', ''));
    put(parameters, 'IAMResourcePrefix', ctx(this, 'iamResourcePrefix', ''));
    put(parameters, 'IAMResourcePath', ctx(this, 'iamResourcePath', '/res/'));

    put(parameters, 'VpcId', vpcId);
    put(parameters, 'IsLoadBalancerInternetFacing', String(boolCtx(this, 'isLoadBalancerInternetFacing', true)));
    put(parameters, 'LoadBalancerSubnets', loadBalancerSubnetIds.join(','));
    put(parameters, 'InfrastructureHostSubnets', infrastructureHostSubnetIds.join(','));
    put(parameters, 'VdiSubnets', vdiSubnetIds.join(','));

    put(parameters, 'ActiveDirectoryName', ctx(this, 'activeDirectoryName', ''));
    put(parameters, 'ADShortName', ctx(this, 'adShortName', ''));
    put(parameters, 'LDAPBase', ctx(this, 'ldapBase', ''));
    put(parameters, 'LDAPConnectionURI', ctx(this, 'ldapConnectionUri', ''));
    put(parameters, 'ServiceAccountCredentialsSecretArn', ctx(this, 'serviceAccountCredentialsSecretArn', ''));
    put(parameters, 'UsersOU', ctx(this, 'usersOu', ''));
    put(parameters, 'GroupsOU', ctx(this, 'groupsOu', ''));
    put(parameters, 'SudoersGroupName', ctx(this, 'sudoersGroupName', 'RESAdministrators'));
    put(parameters, 'ComputersOU', ctx(this, 'computersOu', ''));
    put(parameters, 'DomainTLSCertificateSecretArn', ctx(this, 'domainTlsCertificateSecretArn', ''));
    put(parameters, 'EnableLdapIDMapping', resBool(boolCtx(this, 'enableLdapIDMapping', true)));
    put(parameters, 'DisableADJoin', resBool(boolCtx(this, 'disableADJoin', true)));
    put(parameters, 'ServiceAccountUserDN', ctx(this, 'serviceAccountUserDn', ''));

    put(parameters, 'SharedHomeFileSystemId', sharedHomeFilesystemId);
    put(parameters, 'CustomDomainNameforWebApp', customDomainNameForWebApp);
    put(parameters, 'CustomDomainNameforVDI', ctx(this, 'customDomainNameForVdi', ''));
    put(parameters, 'ACMCertificateARNforWebApp', acmCertificateArnForWebApp);
    put(parameters, 'CertificateSecretARNforVDI', ctx(this, 'certificateSecretArnForVdi', ''));
    put(parameters, 'PrivateKeySecretARNforVDI', ctx(this, 'privateKeySecretArnForVdi', ''));
    put(parameters, 'HttpProxy', ctx(this, 'httpProxy', ''));
    put(parameters, 'HttpsProxy', ctx(this, 'httpsProxy', ''));
    put(parameters, 'NoProxy', ctx(this, 'noProxy', ''));

    put(parameters, 'CognitoUserPoolId', cognitoUserPoolId);
    put(parameters, 'CognitoUserPoolDomainUrl', cognitoUserPoolDomainUrl);

    let resStack: cdk.CfnStack | undefined;

    if (deployRes) {
      if (loadBalancerSubnetIds.length < 2) {
        throw new Error('RES requires at least two loadBalancerSubnetIds or publicSubnetIds in different AZs.');
      }
      if (infrastructureHostSubnetIds.length < 2) {
        throw new Error('RES requires at least two infrastructureHostSubnetIds or privateSubnetIds in different AZs.');
      }
      if (vdiSubnetIds.length < 2) {
        throw new Error('RES requires at least two vdiSubnetIds or privateSubnetIds in different AZs.');
      }
      if (!sharedHomeFilesystemId) {
        throw new Error('SharedHomeFileSystemId is required. Provide efsFileSystemId or set createEfs=true.');
      }
      if (cognitoUserPoolId && !cognitoUserPoolDomainUrl) {
        throw new Error('cognitoUserPoolDomainUrl or cognitoDomainPrefix is required when cognitoUserPoolId is provided.');
      }

      resStack = new cdk.CfnStack(this, 'ResearchEngineeringStudioProductStack', {
        templateUrl: resTemplateUrl,
        parameters,
        timeoutInMinutes: 180
      });

      if (cognitoPrepResource) {
        resStack.addDependency(cognitoPrepResource.node.defaultChild as cdk.CfnResource);
      }

      new CfnOutput(this, 'ResNestedStackId', {
        value: resStack.ref
      });

      if (customDomainNameForWebApp && webAppHostedZone) {
        const externalAlbLookup = new cr.AwsCustomResource(this, 'ResExternalAlbLookup', {
          onCreate: {
            service: '@aws-sdk/client-elastic-load-balancing-v2',
            action: 'DescribeLoadBalancers',
            parameters: {
              Names: [`${resEnvironmentName}-external-alb`]
            },
            physicalResourceId: cr.PhysicalResourceId.of(`${resEnvironmentName}-external-alb`)
          },
          onUpdate: {
            service: '@aws-sdk/client-elastic-load-balancing-v2',
            action: 'DescribeLoadBalancers',
            parameters: {
              Names: [`${resEnvironmentName}-external-alb`]
            },
            physicalResourceId: cr.PhysicalResourceId.of(`${resEnvironmentName}-external-alb`)
          },
          policy: cr.AwsCustomResourcePolicy.fromStatements([
            new iam.PolicyStatement({
              actions: ['elasticloadbalancing:DescribeLoadBalancers'],
              resources: ['*']
            })
          ]),
          installLatestAwsSdk: true
        });
        externalAlbLookup.node.addDependency(resStack);

        const httpsListenerLookup = new cr.AwsCustomResource(this, 'ResExternalHttpsListenerLookup', {
          onCreate: {
            service: '@aws-sdk/client-dynamodb',
            action: 'GetItem',
            parameters: {
              TableName: `${resEnvironmentName}.cluster-settings`,
              Key: {
                key: {
                  S: 'cluster.load_balancers.external_alb.https_listener_arn'
                }
              }
            },
            physicalResourceId: cr.PhysicalResourceId.of(`${resEnvironmentName}-external-https-listener`)
          },
          onUpdate: {
            service: '@aws-sdk/client-dynamodb',
            action: 'GetItem',
            parameters: {
              TableName: `${resEnvironmentName}.cluster-settings`,
              Key: {
                key: {
                  S: 'cluster.load_balancers.external_alb.https_listener_arn'
                }
              }
            },
            physicalResourceId: cr.PhysicalResourceId.of(`${resEnvironmentName}-external-https-listener`)
          },
          policy: cr.AwsCustomResourcePolicy.fromStatements([
            new iam.PolicyStatement({
              actions: ['dynamodb:GetItem'],
              resources: [
                Stack.of(this).formatArn({
                  service: 'dynamodb',
                  resource: 'table',
                  resourceName: `${resEnvironmentName}.cluster-settings`
                })
              ]
            })
          ]),
          installLatestAwsSdk: true
        });
        httpsListenerLookup.node.addDependency(resStack);

        const clusterManagerTargetGroupLookup = new cr.AwsCustomResource(this, 'ResClusterManagerTargetGroupLookup', {
          onCreate: {
            service: '@aws-sdk/client-elastic-load-balancing-v2',
            action: 'DescribeTargetGroups',
            parameters: {
              Names: [clusterManagerExternalTargetGroupName]
            },
            physicalResourceId: cr.PhysicalResourceId.of(clusterManagerExternalTargetGroupName)
          },
          onUpdate: {
            service: '@aws-sdk/client-elastic-load-balancing-v2',
            action: 'DescribeTargetGroups',
            parameters: {
              Names: [clusterManagerExternalTargetGroupName]
            },
            physicalResourceId: cr.PhysicalResourceId.of(clusterManagerExternalTargetGroupName)
          },
          policy: cr.AwsCustomResourcePolicy.fromStatements([
            new iam.PolicyStatement({
              actions: ['elasticloadbalancing:DescribeTargetGroups'],
              resources: ['*']
            })
          ]),
          installLatestAwsSdk: true
        });
        clusterManagerTargetGroupLookup.node.addDependency(resStack);

        const rootWebUiRule = new elbv2.CfnListenerRule(this, 'ResWebUiRootRule', {
          listenerArn: httpsListenerLookup.getResponseField('Item.value.S'),
          priority: 500,
          conditions: [
            {
              field: 'path-pattern',
              values: ['/*']
            }
          ],
          actions: [
            {
              type: 'forward',
              targetGroupArn: clusterManagerTargetGroupLookup.getResponseField('TargetGroups.0.TargetGroupArn')
            }
          ]
        });
        rootWebUiRule.node.addDependency(httpsListenerLookup);
        rootWebUiRule.node.addDependency(clusterManagerTargetGroupLookup);

        const webAppRecord = new route53.CfnRecordSet(this, 'ResWebAppDnsRecord', {
          hostedZoneId: webAppHostedZone.hostedZoneId,
          name: customDomainNameForWebApp,
          type: 'CNAME',
          ttl: '300',
          resourceRecords: [
            externalAlbLookup.getResponseField('LoadBalancers.0.DNSName')
          ]
        });
        new CfnOutput(this, 'ResWebAppUrl', {
          value: `https://${customDomainNameForWebApp}`
        });
      }
    }

    new CfnOutput(this, 'ResTemplateUrl', {
      value: resTemplateUrl
    });

    new CfnOutput(this, 'ResEnvironmentName', {
      value: resEnvironmentName
    });

    new CfnOutput(this, 'ResDataCatalogSecretArn', {
      value: sharedCatalogSecret.secretArn
    });

    new CfnOutput(this, 'ResOhdsiDataAccessPolicyArn', {
      value: dataAccessPolicy.managedPolicyArn
    });

    new CfnOutput(this, 'ResDataClientSecurityGroupId', {
      value: dataClientSecurityGroup.securityGroupId
    });

    new CfnOutput(this, 'LinuxVdiOhdsiProfileS3Uri', {
      value: `s3://${bootstrapAsset.s3BucketName}/${bootstrapAsset.s3ObjectKey}`
    });

    new CfnOutput(this, 'AtlasUrlSsmParameter', {
      value: atlasUrlParam.parameterName
    });

    new CfnOutput(this, 'WebApiUrlSsmParameter', {
      value: webApiUrlParam.parameterName
    });

    new CfnOutput(this, 'OmopEndpointSsmParameter', {
      value: omopEndpointParam.parameterName
    });
  }
}
