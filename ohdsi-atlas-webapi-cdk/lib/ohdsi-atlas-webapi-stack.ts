import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwIntegrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

interface AppConfig {
  siteName: string;
  domainName: string;
  hostedZoneId: string;
  hostedZoneName: string;
  cognitoDomainPrefix: string;
  auroraPostgresEngineVersion: string;
  autoPauseSeconds: number;
  webDbName: string;
  omopDbName: string;
  webDbMaxAcu: number;
  omopDbMaxAcu: number;
  atlasImage: string;
  webApiImage: string;
  desiredCountOnWake: number;
  idleScaleDownMinutes: number;
  natGateways: number;
  synpufS3Uri: string;
  removalPolicy: string;
  enableAlbCognitoAuth: boolean;
  enableExecuteCommand: boolean;
  sourceKey: string;
  sourceName: string;
}

function str(scope: Construct, key: string, fallback: string): string {
  const v = scope.node.tryGetContext(key);
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  return String(v);
}

function num(scope: Construct, key: string, fallback: number): number {
  const v = scope.node.tryGetContext(key);
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Context ${key} must be numeric`);
  return n;
}

function bool(scope: Construct, key: string, fallback: boolean): boolean {
  const v = scope.node.tryGetContext(key);
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  return ['true', '1', 'yes', 'y'].includes(String(v).toLowerCase());
}

function safeName(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 42);
}

export class OhdsiAtlasWebApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const config: AppConfig = {
      siteName: safeName(str(this, 'siteName', 'ohdsi-synpuf')),
      domainName: str(this, 'domainName', ''),
      hostedZoneId: str(this, 'hostedZoneId', ''),
      hostedZoneName: str(this, 'hostedZoneName', ''),
      cognitoDomainPrefix: safeName(str(this, 'cognitoDomainPrefix', 'ohdsi-synpuf-auth-change-me')),
      auroraPostgresEngineVersion: str(this, 'auroraPostgresEngineVersion', '16.6'),
      autoPauseSeconds: num(this, 'autoPauseSeconds', 900),
      webDbName: str(this, 'webDbName', 'ohdsi_webapi'),
      omopDbName: str(this, 'omopDbName', 'ohdsi_omop'),
      webDbMaxAcu: num(this, 'webDbMaxAcu', 2),
      omopDbMaxAcu: num(this, 'omopDbMaxAcu', 8),
      atlasImage: str(this, 'atlasImage', 'ohdsi/atlas:2.14.0'),
      webApiImage: str(this, 'webApiImage', 'ohdsi/webapi:2.14.0'),
      desiredCountOnWake: num(this, 'desiredCountOnWake', 1),
      idleScaleDownMinutes: num(this, 'idleScaleDownMinutes', 120),
      synpufS3Uri: str(this, 'synpufS3Uri', 's3://synpuf-omop/'),
      removalPolicy: str(this, 'removalPolicy', 'SNAPSHOT'),
      enableAlbCognitoAuth: bool(this, 'enableAlbCognitoAuth', true),
      enableExecuteCommand: bool(this, 'enableExecuteCommand', false),
      sourceKey: str(this, 'sourceKey', 'SYNPUF'),
      sourceName: str(this, 'sourceName', 'CMS DE-SynPUF OMOP'),
      natGateways: num(this, 'natGateways', 1),
    };

    const removalPolicy = config.removalPolicy.toUpperCase() === 'DESTROY'
      ? cdk.RemovalPolicy.DESTROY
      : cdk.RemovalPolicy.SNAPSHOT;

    cdk.Tags.of(this).add('Project', 'ResearchOS');
    cdk.Tags.of(this).add('Component', 'OHDSI-ATLAS-WebAPI-SynPUF');
    cdk.Tags.of(this).add('Site', config.siteName);
    cdk.Tags.of(this).add('DataTier', 'Synthetic');

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: config.natGateways,
      subnetConfiguration: [
        { name: 'public-app-no-nat', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private-res-egress', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'isolated-db', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const albSg = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      allowAllOutbound: true,
      description: 'Internet-facing ALB security group',
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP from internet');
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS from internet');

    const serviceSg = new ec2.SecurityGroup(this, 'ServiceSecurityGroup', {
      vpc,
      allowAllOutbound: true,
      description: 'ATLAS, WebAPI, and init-task security group',
    });
    serviceSg.addIngressRule(albSg, ec2.Port.tcp(8080), 'ALB to container port 8080');

    const dbSg = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc,
      allowAllOutbound: true,
      description: 'Aurora PostgreSQL database security group',
    });
    dbSg.addIngressRule(serviceSg, ec2.Port.tcp(5432), 'ECS tasks to Aurora PostgreSQL');

    const webDbSecret = new secretsmanager.Secret(this, 'WebApiDbSecret', {
      description: 'Master credentials for OHDSI WebAPI metadata database',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'postgres' }),
        generateStringKey: 'password',
        excludePunctuation: true,
      },
    });

    const omopDbSecret = new secretsmanager.Secret(this, 'OmopDbSecret', {
      description: 'Master credentials for synthetic OMOP database',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'postgres' }),
        generateStringKey: 'password',
        excludePunctuation: true,
      },
    });

    const dbSubnetGroup = new rds.CfnDBSubnetGroup(this, 'DatabaseSubnetGroup', {
      dbSubnetGroupDescription: 'Private isolated subnet group for Aurora PostgreSQL',
      subnetIds: vpc.isolatedSubnets.map(s => s.subnetId),
    });

    const webCluster = this.createAuroraServerlessCluster({
      id: 'WebApiMetadataDb',
      databaseName: config.webDbName,
      engineVersion: config.auroraPostgresEngineVersion,
      maxAcu: config.webDbMaxAcu,
      autoPauseSeconds: config.autoPauseSeconds,
      subnetGroup: dbSubnetGroup,
      dbSg,
      secret: webDbSecret,
      removalPolicy,
    });

    const omopCluster = this.createAuroraServerlessCluster({
      id: 'SyntheticOmopDb',
      databaseName: config.omopDbName,
      engineVersion: config.auroraPostgresEngineVersion,
      maxAcu: config.omopDbMaxAcu,
      autoPauseSeconds: config.autoPauseSeconds,
      subnetGroup: dbSubnetGroup,
      dbSg,
      secret: omopDbSecret,
      removalPolicy,
    });

    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${config.siteName}-users`,
      selfSignUpEnabled: false,
      signInAliases: { email: true, username: true },
      autoVerify: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      mfa: cognito.Mfa.OPTIONAL,
      passwordPolicy: {
        minLength: 14,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const userPoolDomain = new cognito.UserPoolDomain(this, 'UserPoolDomain', {
      userPool,
      cognitoDomain: { domainPrefix: config.cognitoDomainPrefix },
    });

    const hasCustomDomain = config.domainName !== '' && config.hostedZoneId !== '' && config.hostedZoneName !== '';
    let hostedZone: route53.IHostedZone | undefined;
    let certificate: acm.ICertificate | undefined;

    if (hasCustomDomain) {
      hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId: config.hostedZoneId,
        zoneName: config.hostedZoneName,
      });
      certificate = new acm.Certificate(this, 'AlbCertificate', {
        domainName: config.domainName,
        validation: acm.CertificateValidation.fromDns(hostedZone),
      });
    }

    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      loadBalancerName: `${config.siteName}-alb`,
    });

    const albBaseUrl = hasCustomDomain
      ? `https://${config.domainName}`
      : `http://${loadBalancer.loadBalancerDnsName}`;

    const userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool,
      userPoolClientName: `${config.siteName}-alb-client`,
      generateSecret: true,
      authFlows: {
        userPassword: false,
        adminUserPassword: true,
        userSrp: true,
      },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: hasCustomDomain
          ? [`https://${config.domainName}/oauth2/idpresponse`]
          : ['http://localhost/oauth2/idpresponse'],
        logoutUrls: hasCustomDomain
          ? [`https://${config.domainName}/`]
          : ['http://localhost/'],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
    });

    const cluster = new ecs.Cluster(this, 'EcsCluster', {
      clusterName: `${config.siteName}-ecs`,
      vpc,
      containerInsights: true,
    });

    const atlasLogGroup = new logs.LogGroup(this, 'AtlasLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const webApiLogGroup = new logs.LogGroup(this, 'WebApiLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const initLogGroup = new logs.LogGroup(this, 'InitLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const webApiTaskExecutionRole = new iam.Role(this, 'WebApiTaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    const webApiTaskRole = new iam.Role(this, 'WebApiTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    const webApiTask = new ecs.FargateTaskDefinition(this, 'WebApiTaskDefinition', {
      cpu: 1024,
      memoryLimitMiB: 2048,
      executionRole: webApiTaskExecutionRole,
      taskRole: webApiTaskRole,
    });

    webDbSecret.grantRead(webApiTask.executionRole!);
    webDbSecret.grantRead(webApiTask.taskRole);

    const webJdbcUrl = `jdbc:postgresql://${webCluster.cluster.attrEndpointAddress}:5432/${config.webDbName}`;
    const webApiMetadataSchema = 'webapi';
    const webApiSpringApplicationJson = JSON.stringify({
      datasource: {
        driverClassName: 'org.postgresql.Driver',
        url: webJdbcUrl,
        username: 'postgres',
        ohdsi: {
          schema: webApiMetadataSchema,
        },
      },
      spring: {
        jpa: {
          properties: {
            hibernate: {
              default_schema: webApiMetadataSchema,
            },
          },
        },
        batch: {
          repository: {
            tableprefix: `${webApiMetadataSchema}.BATCH_`,
          },
        },
      },
      flyway: {
        datasource: {
          driverClassName: 'org.postgresql.Driver',
          url: webJdbcUrl,
          username: 'postgres',
        },
        locations: 'classpath:db/migration/postgresql',
        schemas: webApiMetadataSchema,
        placeholders: {
          ohdsiSchema: webApiMetadataSchema,
        },
        baselineOnMigrate: 'true',
      },
    });

    webApiTask.addContainer('webapi', {
      image: ecs.ContainerImage.fromRegistry(config.webApiImage),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'webapi', logGroup: webApiLogGroup }),
      portMappings: [{ containerPort: 8080, protocol: ecs.Protocol.TCP }],
      environment: {
        JAVA_OPTS: '-Xms512m -Xmx1536m -Djava.awt.headless=true',
        SPRING_APPLICATION_JSON: webApiSpringApplicationJson,
        env: 'webapi-postgresql',
        datasource_driverClassName: 'org.postgresql.Driver',
        datasource_url: webJdbcUrl,
        datasource_username: 'postgres',
        datasource_ohdsi_schema: webApiMetadataSchema,
        spring_jpa_properties_hibernate_default__schema: webApiMetadataSchema,
        spring_batch_repository_tableprefix: `${webApiMetadataSchema}.BATCH_`,
        flyway_datasource_driverClassName: 'org.postgresql.Driver',
        flyway_datasource_url: webJdbcUrl,
        flyway_datasource_username: 'postgres',
        flyway_locations: 'classpath:db/migration/postgresql',
        flyway_schemas: webApiMetadataSchema,
        flyway_placeholders_ohdsiSchema: webApiMetadataSchema,
        flyway_baselineOnMigrate: 'true',
        security_provider: 'DisabledSecurity',
        security_origin: hasCustomDomain ? `https://${config.domainName}` : '*',
        server_compression_enabled: 'true',
      },
      secrets: {
        datasource_password: ecs.Secret.fromSecretsManager(webDbSecret, 'password'),
        flyway_datasource_password: ecs.Secret.fromSecretsManager(webDbSecret, 'password'),
      },
      healthCheck: {
        command: ['CMD-SHELL', 'curl -fsS http://localhost:8080/WebAPI/info || exit 1'],
        interval: cdk.Duration.seconds(60),
        retries: 5,
        startPeriod: cdk.Duration.minutes(5),
        timeout: cdk.Duration.seconds(10),
      },
    });

    const atlasTask = new ecs.FargateTaskDefinition(this, 'AtlasTaskDefinition', {
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    atlasTask.addContainer('atlas', {
      image: ecs.ContainerImage.fromRegistry(config.atlasImage),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'atlas', logGroup: atlasLogGroup }),
      portMappings: [{ containerPort: 8080, protocol: ecs.Protocol.TCP }],
      environment: {
        WEBAPI_URL: `${albBaseUrl}/WebAPI/`,
        ATLAS_HOSTNAME: hasCustomDomain ? config.domainName : loadBalancer.loadBalancerDnsName,
        ATLAS_INSTANCE_NAME: `${config.siteName} SynPUF`,
        ATLAS_USER_AUTH_ENABLED: 'false',
      },
      healthCheck: {
        command: ['CMD-SHELL', 'curl -fsS http://localhost:8080/atlas/ || exit 1'],
        interval: cdk.Duration.seconds(60),
        retries: 5,
        startPeriod: cdk.Duration.minutes(2),
        timeout: cdk.Duration.seconds(10),
      },
    });

    const atlasService = new ecs.FargateService(this, 'AtlasService', {
      cluster,
      taskDefinition: atlasTask,
      serviceName: `${config.siteName}-atlas`,
      desiredCount: 0,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [serviceSg],
      enableExecuteCommand: config.enableExecuteCommand,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 0,
      maxHealthyPercent: 200,
    });

    const webApiService = new ecs.FargateService(this, 'WebApiService', {
      cluster,
      taskDefinition: webApiTask,
      serviceName: `${config.siteName}-webapi`,
      desiredCount: 0,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [serviceSg],
      enableExecuteCommand: config.enableExecuteCommand,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 0,
      maxHealthyPercent: 200,
    });

    webApiService.node.addDependency(webCluster.instance);
    atlasService.node.addDependency(webApiService);

    const atlasTg = new elbv2.ApplicationTargetGroup(this, 'AtlasTargetGroup', {
      vpc,
      targetType: elbv2.TargetType.IP,
      protocol: elbv2.ApplicationProtocol.HTTP,
      port: 8080,
      deregistrationDelay: cdk.Duration.seconds(15),
      healthCheck: {
        enabled: true,
        path: '/atlas/',
        healthyHttpCodes: '200-399',
        interval: cdk.Duration.seconds(60),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5,
      },
    });

    const webApiTg = new elbv2.ApplicationTargetGroup(this, 'WebApiTargetGroup', {
      vpc,
      targetType: elbv2.TargetType.IP,
      protocol: elbv2.ApplicationProtocol.HTTP,
      port: 8080,
      deregistrationDelay: cdk.Duration.seconds(15),
      healthCheck: {
        enabled: true,
        path: '/WebAPI/info',
        healthyHttpCodes: '200-399',
        interval: cdk.Duration.seconds(60),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5,
      },
    });

    atlasService.attachToApplicationTargetGroup(atlasTg);
    webApiService.attachToApplicationTargetGroup(webApiTg);

    const albCognitoAuthActuallyEnabled = config.enableAlbCognitoAuth && hasCustomDomain;

    const httpListener = loadBalancer.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: hasCustomDomain
        ? elbv2.ListenerAction.redirect({ protocol: 'HTTPS', port: '443', permanent: true })
        : elbv2.ListenerAction.fixedResponse(200, {
            contentType: 'text/plain',
            messageBody: 'OHDSI ALB is up. Use the LauncherUrl CloudFormation output to wake ATLAS/WebAPI.',
          }),
    });

    let appListener: elbv2.ApplicationListener = httpListener;

    if (certificate) {
      appListener = loadBalancer.addListener('HttpsListener', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [certificate],
        defaultAction: elbv2.ListenerAction.fixedResponse(200, {
          contentType: 'text/plain',
          messageBody: 'OHDSI ALB is up. Use the LauncherUrl CloudFormation output to wake ATLAS/WebAPI.',
        }),
      });
    }

    const addPathRule = (id: string, priority: number, pathPatterns: string[], tg: elbv2.IApplicationTargetGroup) => {
      if (!albCognitoAuthActuallyEnabled) {
        appListener.addAction(id, {
          priority,
          conditions: [elbv2.ListenerCondition.pathPatterns(pathPatterns)],
          action: elbv2.ListenerAction.forward([tg]),
        });
        return;
      }

      new elbv2.CfnListenerRule(this, id, {
        listenerArn: appListener.listenerArn,
        priority,
        conditions: [
          {
            field: 'path-pattern',
            pathPatternConfig: { values: pathPatterns },
          },
        ],
        actions: [
          {
            type: 'authenticate-cognito',
            order: 1,
            authenticateCognitoConfig: {
              userPoolArn: userPool.userPoolArn,
              userPoolClientId: userPoolClient.userPoolClientId,
              userPoolDomain: userPoolDomain.domainName,
              onUnauthenticatedRequest: 'authenticate',
              scope: 'openid email profile',
              sessionTimeout: cdk.Duration.hours(8).toSeconds(),
            },
          },
          {
            type: 'forward',
            order: 2,
            targetGroupArn: tg.targetGroupArn,
          },
        ],
      });
    };

    addPathRule('AtlasRule', 10, ['/atlas', '/atlas/*'], atlasTg);
    addPathRule('WebApiRule', 20, ['/WebAPI', '/WebAPI/*'], webApiTg);

    if (hostedZone) {
      new route53.ARecord(this, 'AlbAliasRecord', {
        zone: hostedZone,
        recordName: config.domainName,
        target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(loadBalancer)),
      });
    }

    const initImage = new ecrAssets.DockerImageAsset(this, 'InitRunnerImage', {
      directory: 'docker/db-init-runner',
      platform: ecrAssets.Platform.LINUX_AMD64,
    });

    const initTaskExecutionRole = new iam.Role(this, 'InitTaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    const initTaskRole = new iam.Role(this, 'InitTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    const initTask = new ecs.FargateTaskDefinition(this, 'InitTaskDefinition', {
      cpu: 2048,
      memoryLimitMiB: 4096,
      executionRole: initTaskExecutionRole,
      taskRole: initTaskRole,
    });

    for (const secret of [webDbSecret, omopDbSecret]) {
      secret.grantRead(initTask.taskRole);
      secret.grantRead(initTask.executionRole!);
    }

    initTask.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: ['arn:aws:s3:::synpuf-omop'],
    }));
    initTask.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: ['arn:aws:s3:::synpuf-omop/*'],
    }));

    initTask.addContainer('db-init', {
      image: ecs.ContainerImage.fromDockerImageAsset(initImage),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'db-init', logGroup: initLogGroup }),
      environment: {
        INIT_COMMAND: 'schemas',
        WEB_DB_HOST: webCluster.cluster.attrEndpointAddress,
        WEB_DB_NAME: config.webDbName,
        WEB_DB_SECRET_ARN: webDbSecret.secretArn,
        WEBAPI_SCHEMA: 'webapi',
        OMOP_DB_HOST: omopCluster.cluster.attrEndpointAddress,
        OMOP_DB_NAME: config.omopDbName,
        OMOP_DB_SECRET_ARN: omopDbSecret.secretArn,
        CDM_SCHEMA: 'cdm_synpuf',
        VOCAB_SCHEMA: 'cdm_synpuf',
        RESULTS_SCHEMA: 'results_synpuf',
        TEMP_SCHEMA: 'temp_synpuf',
        SYNPUF_S3_URI: config.synpufS3Uri,
        SOURCE_KEY: config.sourceKey,
        SOURCE_NAME: config.sourceName,
      },
    });

    const wakeFn = new lambda.Function(this, 'WakeOrchestratorFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'wake_orchestrator.handler',
      code: lambda.Code.fromAsset('lambda'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        ECS_CLUSTER: cluster.clusterName,
        ATLAS_SERVICE: atlasService.serviceName,
        WEBAPI_SERVICE: webApiService.serviceName,
        DESIRED_COUNT_ON_WAKE: String(config.desiredCountOnWake),
        IDLE_SCALE_DOWN_MINUTES: String(config.idleScaleDownMinutes),
        ATLAS_TG_ARN: atlasTg.targetGroupArn,
        WEBAPI_TG_ARN: webApiTg.targetGroupArn,
        ATLAS_TG_FULL_NAME: atlasTg.targetGroupFullName,
        WEBAPI_TG_FULL_NAME: webApiTg.targetGroupFullName,
        LOAD_BALANCER_FULL_NAME: loadBalancer.loadBalancerFullName,
        ALB_BASE_URL: albBaseUrl,
        ATLAS_URL: `${albBaseUrl}/atlas/`,
        WEBAPI_INFO_URL: `${albBaseUrl}/WebAPI/info`,
      },
    });

    wakeFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:DescribeServices', 'ecs:UpdateService'],
      resources: ['*'],
    }));
    wakeFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['elasticloadbalancing:DescribeTargetHealth'],
      resources: ['*'],
    }));
    wakeFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:GetMetricStatistics'],
      resources: ['*'],
    }));

    const launcherApi = new apigwv2.HttpApi(this, 'LauncherApi', {
      apiName: `${config.siteName}-wake-launcher`,
      corsPreflight: {
        allowHeaders: ['content-type'],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.OPTIONS],
        allowOrigins: ['*'],
      },
    });
    const wakeIntegration = new apigwIntegrations.HttpLambdaIntegration('WakeIntegration', wakeFn);
    launcherApi.addRoutes({ path: '/', methods: [apigwv2.HttpMethod.GET], integration: wakeIntegration });
    launcherApi.addRoutes({ path: '/wake', methods: [apigwv2.HttpMethod.POST], integration: wakeIntegration });
    launcherApi.addRoutes({ path: '/status', methods: [apigwv2.HttpMethod.GET], integration: wakeIntegration });
    launcherApi.addRoutes({ path: '/sleep', methods: [apigwv2.HttpMethod.POST], integration: wakeIntegration });

    new events.Rule(this, 'IdleScaleDownRule', {
      description: `Scale ATLAS/WebAPI ECS services back to 0 after ${config.idleScaleDownMinutes} minutes without ALB requests`,
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
      targets: [new eventTargets.LambdaFunction(wakeFn, {
        event: events.RuleTargetInput.fromObject({ action: 'idle-down' }),
      })],
    });

    new cdk.CfnOutput(this, 'LauncherUrl', { value: launcherApi.apiEndpoint });
    new cdk.CfnOutput(this, 'AtlasUrl', { value: `${albBaseUrl}/atlas/` });
    new cdk.CfnOutput(this, 'WebApiInfoUrl', { value: `${albBaseUrl}/WebAPI/info` });
    new cdk.CfnOutput(this, 'AlbDnsName', { value: loadBalancer.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'AlbBaseUrl', { value: albBaseUrl });
    new cdk.CfnOutput(this, 'CognitoUserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'CognitoUserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'CognitoUserPoolDomainUrl', { value: userPoolDomain.baseUrl() });
    new cdk.CfnOutput(this, 'AlbCognitoAuthEnabled', { value: String(albCognitoAuthActuallyEnabled) });
    new cdk.CfnOutput(this, 'EcsClusterName', { value: cluster.clusterName });
    new cdk.CfnOutput(this, 'AtlasServiceName', { value: atlasService.serviceName });
    new cdk.CfnOutput(this, 'WebApiServiceName', { value: webApiService.serviceName });
    new cdk.CfnOutput(this, 'InitTaskDefinitionArn', { value: initTask.taskDefinitionArn });
    new cdk.CfnOutput(this, 'ServiceSecurityGroupId', { value: serviceSg.securityGroupId });
    new cdk.CfnOutput(this, 'OmopDbSecurityGroupId', { value: dbSg.securityGroupId });
    new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId });
    new cdk.CfnOutput(this, 'VpcCidr', { value: vpc.vpcCidrBlock });
    new cdk.CfnOutput(this, 'AvailabilityZones', { value: vpc.availabilityZones.join(',') });
    new cdk.CfnOutput(this, 'PublicSubnetIds', { value: vpc.publicSubnets.map(s => s.subnetId).join(',') });
    new cdk.CfnOutput(this, 'PrivateSubnetIds', { value: vpc.privateSubnets.map(s => s.subnetId).join(',') });
    new cdk.CfnOutput(this, 'WebDbEndpoint', { value: webCluster.cluster.attrEndpointAddress });
    new cdk.CfnOutput(this, 'OmopDbEndpoint', { value: omopCluster.cluster.attrEndpointAddress });
    new cdk.CfnOutput(this, 'WebApiDbSecretArn', { value: webDbSecret.secretArn });
    new cdk.CfnOutput(this, 'OmopDbSecretArn', { value: omopDbSecret.secretArn });
  }

  private createAuroraServerlessCluster(args: {
    id: string;
    databaseName: string;
    engineVersion: string;
    maxAcu: number;
    autoPauseSeconds: number;
    subnetGroup: rds.CfnDBSubnetGroup;
    dbSg: ec2.ISecurityGroup;
    secret: secretsmanager.ISecret;
    removalPolicy: cdk.RemovalPolicy;
  }): { cluster: rds.CfnDBCluster; instance: rds.CfnDBInstance } {
    const cluster = new rds.CfnDBCluster(this, `${args.id}Cluster`, {
      engine: 'aurora-postgresql',
      engineVersion: args.engineVersion,
      databaseName: args.databaseName,
      masterUsername: args.secret.secretValueFromJson('username').toString(),
      masterUserPassword: args.secret.secretValueFromJson('password').toString(),
      dbSubnetGroupName: args.subnetGroup.ref,
      vpcSecurityGroupIds: [args.dbSg.securityGroupId],
      storageEncrypted: true,
      serverlessV2ScalingConfiguration: {
        minCapacity: 0,
        maxCapacity: args.maxAcu,
        secondsUntilAutoPause: args.autoPauseSeconds,
      } as rds.CfnDBCluster.ServerlessV2ScalingConfigurationProperty,
      deletionProtection: false,
      copyTagsToSnapshot: true,
      backupRetentionPeriod: 7,
    });
    cluster.addPropertyOverride('ServerlessV2ScalingConfiguration.SecondsUntilAutoPause', args.autoPauseSeconds);
    cluster.applyRemovalPolicy(args.removalPolicy);

    const instance = new rds.CfnDBInstance(this, `${args.id}Instance`, {
      engine: 'aurora-postgresql',
      dbClusterIdentifier: cluster.ref,
      dbInstanceClass: 'db.serverless',
      publiclyAccessible: false,
      autoMinorVersionUpgrade: true,
    });
    instance.applyRemovalPolicy(args.removalPolicy);
    instance.addDependency(cluster);

    return { cluster, instance };
  }
}
