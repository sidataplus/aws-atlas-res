import * as assert from 'assert';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as fs from 'fs';
import * as path from 'path';
import { OhdsiAtlasWebApiStack } from '../lib/ohdsi-atlas-webapi-stack';

const app = new cdk.App({
  context: {
    siteName: 'ohdsi-synpuf',
    domainName: 'ohdsi.research.sidata.plus',
    hostedZoneId: 'ZTEST',
    hostedZoneName: 'research.sidata.plus',
    cognitoDomainPrefix: 'ohdsi-synpuf-auth-test',
    synpufS3Uri: 's3://synpuf-omop/cmsdesynpuf1k/',
  },
});

const stack = new OhdsiAtlasWebApiStack(app, 'TestStack', {
  env: {
    account: '248189943046',
    region: 'ap-southeast-1',
  },
});

const template = Template.fromStack(stack);
const json = template.toJSON();

template.hasResourceProperties('AWS::EC2::Subnet', {
  Tags: Match.arrayWith([
    {
      Key: 'aws-cdk:subnet-type',
      Value: 'Private',
    },
  ]),
});

template.resourceCountIs('AWS::EC2::NatGateway', 1);
template.hasResourceProperties('AWS::EC2::Route', {
  DestinationCidrBlock: '0.0.0.0/0',
  NatGatewayId: Match.anyValue(),
});

for (const outputName of [
  'VpcId',
  'VpcCidr',
  'AvailabilityZones',
  'PrivateSubnetIds',
  'OmopDbSecurityGroupId',
  'CognitoUserPoolDomainUrl',
]) {
  assert.ok(json.Outputs[outputName], `Expected CloudFormation output ${outputName}`);
}

template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
  Actions: Match.arrayWith([
    Match.objectLike({
      Type: 'authenticate-cognito',
    }),
    Match.objectLike({
      Type: 'forward',
    }),
  ]),
});

const taskDefinitions = template.findResources('AWS::ECS::TaskDefinition');
const webApiContainer = Object.values(taskDefinitions)
  .flatMap((resource: any) => resource.Properties.ContainerDefinitions)
  .find((container: any) => container.Name === 'webapi');
const springApplicationJson = webApiContainer.Environment.find((entry: any) => entry.Name === 'SPRING_APPLICATION_JSON');
const renderedSpringApplicationJson = JSON.stringify(springApplicationJson.Value);

for (const expectedFragment of [
  'datasource',
  'ohdsi',
  'schema',
  'webapi',
  'default_schema',
  'flyway',
  'ohdsiSchema',
]) {
  assert.ok(
    renderedSpringApplicationJson.includes(expectedFragment),
    `Expected SPRING_APPLICATION_JSON to include ${expectedFragment}`,
  );
}

template.hasResourceProperties('AWS::RDS::DBCluster', {
  ServerlessV2ScalingConfiguration: Match.objectLike({
    MinCapacity: 0,
    SecondsUntilAutoPause: 900,
  }),
});

const assembly = app.synth();
const assetsPath = path.join(assembly.directory, 'TestStack.assets.json');
const assets = JSON.parse(fs.readFileSync(assetsPath, 'utf8'));
const dockerAssets = Object.values(assets.dockerImages) as Array<{ source: { platform?: string } }>;

assert.ok(
  dockerAssets.some(asset => asset.source.platform === 'linux/amd64'),
  'Expected init Docker image asset to build for linux/amd64 so it runs on Fargate x86_64',
);

const initRunner = fs.readFileSync(path.join(__dirname, '..', 'docker', 'db-init-runner', 'init_synpuf.py'), 'utf8');
for (const expectedFragment of ['import bz2', '.csv.bz2', 'bz2.open']) {
  assert.ok(initRunner.includes(expectedFragment), `Expected init runner to support SynPUF ${expectedFragment}`);
}

for (const expectedFragment of ['delete_daimons_sql', 'delete_source_sql', 'insert_source_sql']) {
  assert.ok(initRunner.includes(expectedFragment), `Expected register-source SQL to split ${expectedFragment}`);
}
