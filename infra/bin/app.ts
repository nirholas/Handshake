#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ThreeWsStack } from '../lib/three-ws-stack';

const app = new cdk.App();

const stack = new ThreeWsStack(app, 'ThreeWsStack', {
  env: {
    account: '155407237916',
    region: 'us-east-1',
  },
  description: 'three.ws — platform for 3D AI agents on-chain',
});

// Tag every resource in this stack with the MyApplications application tag.
// This makes them visible in the three.ws AWS application dashboard.
cdk.Tags.of(stack).add(
  'awsApplication',
  'arn:aws:resource-groups:us-east-1:155407237916:group/three.ws/03adso8olrmj6rbu0wvadul7ih',
);
