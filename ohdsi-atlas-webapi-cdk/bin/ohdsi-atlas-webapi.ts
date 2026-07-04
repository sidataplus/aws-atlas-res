#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { OhdsiAtlasWebApiStack } from '../lib/ohdsi-atlas-webapi-stack';

const app = new cdk.App();

new OhdsiAtlasWebApiStack(app, 'OhdsiAtlasWebApiStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
});
