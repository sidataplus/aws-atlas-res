#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ResearchOsResStack } from '../lib/researchos-res-stack';

const app = new cdk.App();

new ResearchOsResStack(app, 'ResearchOsResStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION
  }
});
