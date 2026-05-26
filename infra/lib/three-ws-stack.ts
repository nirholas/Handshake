import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export class ThreeWsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Avatar asset bucket — used by api/_lib/r2.js for 3D avatar uploads
    const avatarBucket = new s3.Bucket(this, 'AvatarBucket', {
      bucketName: '3d-agent-avatars',
      versioned: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: false, // CDN serves public reads via CloudFront/R2 domain
      }),
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.HEAD],
          allowedOrigins: ['https://three.ws', 'https://*.three.ws', 'http://localhost:3000'],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        {
          id: 'expire-tmp',
          prefix: 'tmp/',
          expiration: cdk.Duration.days(1),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // CloudWatch log group for API-level observability (Vercel forwards structured logs here)
    new logs.LogGroup(this, 'ApiLogGroup', {
      logGroupName: '/three-ws/api',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Associate this CloudFormation stack with the three.ws MyApplications entry.
    // This surfaces all stack resources in the AWS MyApplications dashboard.
    new cdk.CfnResource(this, 'AppRegistryAssociation', {
      type: 'AWS::ServiceCatalogAppRegistry::ResourceAssociation',
      properties: {
        Application: 'arn:aws:servicecatalog:us-east-1:155407237916:/applications/03adso8olrmj6rbu0wvadul7ih',
        Resource: cdk.Aws.STACK_ID,
        ResourceType: 'CFN_STACK',
      },
    });

    new cdk.CfnOutput(this, 'AvatarBucketName', { value: avatarBucket.bucketName });
    new cdk.CfnOutput(this, 'AvatarBucketArn', { value: avatarBucket.bucketArn });
  }
}
