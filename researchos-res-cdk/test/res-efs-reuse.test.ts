import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ResearchOsResStack } from '../lib/researchos-res-stack';

function synthTemplate(context: Record<string, string | boolean>) {
  const app = new cdk.App({ context });
  const stack = new ResearchOsResStack(app, 'TestStack', {
    env: {
      account: '248189943046',
      region: 'ap-southeast-1'
    }
  });
  return Template.fromStack(stack);
}

const template = synthTemplate({
  deployRes: false,
  createEfs: false,
  createEfsMountTargets: true,
  efsFileSystemId: 'fs-0123456789abcdef0',
  vpcId: 'vpc-0123456789abcdef0',
  vpcCidr: '10.0.0.0/16',
  availabilityZones: 'ap-southeast-1a,ap-southeast-1b',
  publicSubnetIds: 'subnet-public-a,subnet-public-b',
  privateSubnetIds: 'subnet-private-a,subnet-private-b'
});

assert.equal(Object.keys(template.findResources('AWS::EFS::FileSystem')).length, 0);
template.resourceCountIs('AWS::EFS::MountTarget', 2);
template.hasResourceProperties('AWS::EFS::MountTarget', {
  FileSystemId: 'fs-0123456789abcdef0',
  SubnetId: 'subnet-private-a'
});
template.hasResourceProperties('AWS::EFS::MountTarget', {
  FileSystemId: 'fs-0123456789abcdef0',
  SubnetId: 'subnet-private-b'
});
template.hasOutput('ResSharedHomeFileSystemId', {
  Value: 'fs-0123456789abcdef0'
});

const customDomainTemplate = synthTemplate({
  deployRes: true,
  createEfs: false,
  efsFileSystemId: 'fs-0123456789abcdef0',
  vpcId: 'vpc-0123456789abcdef0',
  vpcCidr: '10.0.0.0/16',
  availabilityZones: 'ap-southeast-1a,ap-southeast-1b',
  publicSubnetIds: 'subnet-public-a,subnet-public-b',
  privateSubnetIds: 'subnet-private-a,subnet-private-b',
  resTemplateUrl: 'https://example.com/res-template.json',
  administratorEmail: 'max@sidata.plus',
  sshKeyPair: 'res-ohdsi-ap-southeast-1',
  customDomainNameForWebApp: 'res.research.sidata.plus',
  hostedZoneId: 'ZTEST',
  hostedZoneName: 'research.sidata.plus'
});

customDomainTemplate.hasResourceProperties('AWS::CertificateManager::Certificate', {
  DomainName: 'res.research.sidata.plus',
  DomainValidationOptions: Match.arrayWith([
    Match.objectLike({
      DomainName: 'res.research.sidata.plus',
      HostedZoneId: 'ZTEST'
    })
  ])
});
customDomainTemplate.hasResourceProperties('AWS::CloudFormation::Stack', {
  Parameters: Match.objectLike({
    ACMCertificateARNforWebApp: {
      Ref: Match.stringLikeRegexp('ResWebAppCertificate')
    },
    CustomDomainNameforWebApp: 'res.research.sidata.plus'
  })
});
customDomainTemplate.hasResourceProperties('Custom::AWS', {
  Create: Match.serializedJson(Match.objectLike({
    service: '@aws-sdk/client-elastic-load-balancing-v2',
    action: 'DescribeLoadBalancers',
    parameters: {
      Names: ['res-ohdsi-external-alb']
    }
  }))
});
customDomainTemplate.hasResourceProperties('Custom::AWS', {
  Create: Match.serializedJson(Match.objectLike({
    service: '@aws-sdk/client-dynamodb',
    action: 'GetItem',
    parameters: {
      TableName: 'res-ohdsi.cluster-settings',
      Key: {
        key: {
          S: 'cluster.load_balancers.external_alb.https_listener_arn'
        }
      }
    }
  }))
});
customDomainTemplate.hasResourceProperties('Custom::AWS', {
  Create: Match.serializedJson(Match.objectLike({
    service: '@aws-sdk/client-elastic-load-balancing-v2',
    action: 'DescribeTargetGroups',
    parameters: {
      Names: ['res-ohdsi-cm-ext-ae72f4e0']
    }
  }))
});
customDomainTemplate.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
  Priority: 500,
  Conditions: [
    {
      Field: 'path-pattern',
      Values: ['/*']
    }
  ],
  Actions: Match.arrayWith([
    Match.objectLike({
      Type: 'forward'
    })
  ])
});
customDomainTemplate.hasResourceProperties('AWS::Route53::RecordSet', {
  HostedZoneId: 'ZTEST',
  Name: 'res.research.sidata.plus',
  Type: 'CNAME',
  TTL: '300'
});
customDomainTemplate.hasOutput('ResWebAppUrl', {
  Value: 'https://res.research.sidata.plus'
});

const linuxVdiProfile = fs.readFileSync(
  path.join(__dirname, '..', 'bootstrap', 'linux-vdi', 'ohdsi_profile.sh'),
  'utf8'
);

assert.match(linuxVdiProfile, /ohdsi-enable-gdm-autologin/);
assert.match(linuxVdiProfile, /"AutomaticLoginEnable": "true"/);
assert.match(linuxVdiProfile, /"AutomaticLogin": owner/);
assert.match(linuxVdiProfile, /ohdsi-disable-gnome-screen-lock/);
assert.match(linuxVdiProfile, /org\.gnome\.desktop\.screensaver lock-enabled false/);
assert.match(linuxVdiProfile, /org\.gnome\.desktop\.session idle-delay 0/);

console.log('res-efs-reuse.test.ts passed');
