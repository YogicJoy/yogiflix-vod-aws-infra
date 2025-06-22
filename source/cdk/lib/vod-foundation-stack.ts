import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import { HttpMethods } from 'aws-cdk-lib/aws-s3';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as appreg from '@aws-cdk/aws-servicecatalogappregistry-alpha';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin, S3Origin } from 'aws-cdk-lib/aws-cloudfront-origins';

import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { EventbridgeToLambda } from '@aws-solutions-constructs/aws-eventbridge-lambda';
import { LambdaToSns } from '@aws-solutions-constructs/aws-lambda-sns';

export class VodFoundation extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // 1. Parameters & Mappings
        const solutionId = 'Yogiflix';
        const solutionName = 'Yogiflix Video on Demand';
        const solutionVersion = scope.node.tryGetContext('solution_version') ?? '%%VERSION%%';
        this.templateOptions.description = `(${solutionId}) ${solutionName} Solution Implementation. Version ${solutionVersion}`;
        
        const adminEmail = new cdk.CfnParameter(this, "emailAddress", {
            type: "String",
            description: "The admin email address to receive SNS notifications for job status.",
            allowedPattern: "^[_A-Za-z0-9-\\+]+(\\.[_A-Za-z0-9-]+)*@[A-Za-z0-9-]+(\\.[A-Za-z0-9]+)*(\\.[A-Za-z]{2,})$"
        });

        const sendMetrics = new cdk.CfnMapping(this, 'Send', {
            mapping: { AnonymizedUsage: { Data: 'Yes' } }
        });

        // 2. Buckets
        const logsBucket = new s3.Bucket(this, 'Logs', {
            encryption: s3.BucketEncryption.S3_MANAGED,
            publicReadAccess: false,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
            enforceSSL: true,
            versioned: true
        });

        const source = new s3.Bucket(this, 'Source', {
            serverAccessLogsBucket: logsBucket,
            serverAccessLogsPrefix: 'source-bucket-logs/',
            encryption: s3.BucketEncryption.S3_MANAGED,
            publicReadAccess: false,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            versioned: true
        });

        const destination = new s3.Bucket(this, 'Destination', {
            serverAccessLogsBucket: logsBucket,
            serverAccessLogsPrefix: 'destination-bucket-logs/',
            encryption: s3.BucketEncryption.S3_MANAGED,
            publicReadAccess: false,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            cors: [{
                maxAge: 3000,
                allowedOrigins: ['*'],
                allowedHeaders: ['*'],
                allowedMethods: [HttpMethods.GET]
            }],
            enforceSSL: true,
            versioned: true
        });

        // 3. CloudFront Public Key & Key Group
        const publicKey = new cloudfront.PublicKey(this, 'YogicJoyPublicKey', {
            encodedKey: '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAg7ZID5WfX2tJI7PNlg7z4Obj/0AIWX/FH4FHhkq2jF2Qq3Kubv4h3Nlg6yMLIGUy0oC+MWYJ6RfeAlcVo4z3YZy1XuEp87cFLSs5gCmvO4lCOgeqIY7dbxH2wBcukBSd1RCGynpRaa2htbU2tUUl1uIs+MLOuk0cgR/XhHPSJ141TuzstW3I1k9ZWSxAZUyOviGaxe+Yo/FLNIQNCo50zrIIEg+NMlGP/pGmhIoboGxyNvIG0sEaJS/hhXwErZl1Xr29NLuwueQHn+kJTw4JDQKMrUsikuYoVQ+hMpX3vkCesig3zq1+Hfbq2kLkK23eY13eB4YlCqVdZQgdzZSv/wIDAQAB\n-----END PUBLIC KEY-----',
            comment: 'Public key for signed URLs/cookies needed for Yogiflix Video on Demand Foundation',
            publicKeyName: 'YogicJoyPublicKey'
        });
        const keyGroup = new cloudfront.KeyGroup(this, 'YogicJoyKeyGroup', {
            items: [publicKey],
            keyGroupName: 'YogicJoyKeyGroup'
        });

        // 4. Origin Access Control (OAC)
        const oac = new cloudfront.CfnOriginAccessControl(this, 'YogiflixOAC', {
            originAccessControlConfig: {
                name: 'YogiflixOAC',
                originAccessControlOriginType: 's3',
                signingBehavior: 'always',
                signingProtocol: 'sigv4',
                description: 'OAC for S3 origin'
            }
        });

        // 5. IAM Roles & Policies (example for getSignedUrlLambda)
        const getSignedUrlLambdaRole = new iam.Role(this, 'GetSignedUrlLambdaRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        });

        getSignedUrlLambdaRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents',
                'secretsmanager:GetSecretValue'
            ],
            resources: [
                'arn:aws:secretsmanager:us-east-1:686218048045:secret:YOGIFILX_SECRET_ID-zjQ0pI'
            ]
        }));

        getSignedUrlLambdaRole.addManagedPolicy(
            iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
        );

        NagSuppressions.addResourceSuppressions(
            getSignedUrlLambdaRole,
            [
                {
                    id: 'AwsSolutions-IAM5',
                    reason: 'Lambda needs to access secrets for signing CloudFront URLs. Restrict to specific secret in production.',
                    appliesTo: ['Resource::*']
                },
                {
                    id: 'AwsSolutions-IAM4',
                    reason: 'The IAM user, role, or group uses AWS managed policies.'
                }
            ]
        );

        // 6. Lambda Functions (example for getSignedUrlLambda)
        
        const getSignedUrlLambda = new lambda.Function(this, 'GetSignedUrlLambda', {
            code: lambda.Code.fromAsset('../get-signed-url'),
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'index.handler',
            timeout: cdk.Duration.seconds(30),
            role: getSignedUrlLambdaRole,
            retryAttempts: 0,
            environment: {
                SECRET_ID: 'YOGIFILX_SECRET_ID',
                RESOURCE_PATTERN: `https://YOUR_CLOUDFRONT_DOMAIN/*`,
                KEY_PAIR_ID: publicKey.publicKeyId,
            }
        });

        const getSignedURLLambdaAccessLogGroup = new logs.LogGroup(this, 'GetSignedUrlLambdaLogGroup', {
            logGroupName: `/aws/lambda/${getSignedUrlLambda.functionName}`,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            retention: logs.RetentionDays.ONE_WEEK,
        });

        // 7. API Gateway
        const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogs');
        const api = new cdk.aws_apigateway.LambdaRestApi(this, 'GetSignedUrlApi', {
            handler: getSignedUrlLambda,
            proxy: true,
            deployOptions: {
                stageName: 'prod',
                accessLogDestination: new cdk.aws_apigateway.LogGroupLogDestination(accessLogGroup),
                accessLogFormat: cdk.aws_apigateway.AccessLogFormat.jsonWithStandardFields()
            },
            defaultMethodOptions: {
                requestValidatorOptions: {
                    validateRequestBody: true,
                    validateRequestParameters: true
                }
            }
        });

        NagSuppressions.addResourceSuppressionsByPath(this, '/VodFoundation/GetSignedUrlApi/CloudWatchRole/Resource', [
            {
                id: 'AwsSolutions-IAM4',
                reason: 'API Gateway requires this managed policy for logging.'
            }
        ]);

        NagSuppressions.addResourceSuppressionsByPath(this, '/VodFoundation/GetSignedUrlApi/Default/{proxy+}/ANY/Resource', [
            {
                id: 'AwsSolutions-APIG4',
                reason: 'Custom header-based authentication is implemented in Lambda.'
            },
            {
                id: 'AwsSolutions-COG4',
                reason: 'Cognito is not used; custom authentication is implemented.'
            }
        ]);
        NagSuppressions.addResourceSuppressionsByPath(this, '/VodFoundation/GetSignedUrlApi/Default/ANY/Resource', [
            {
                id: 'AwsSolutions-APIG4',
                reason: 'Custom header-based authentication is implemented in Lambda.'
            },
            {
                id: 'AwsSolutions-COG4',
                reason: 'Cognito is not used; custom authentication is implemented.'
            }
        ]);

        NagSuppressions.addResourceSuppressionsByPath(this, '/VodFoundation/GetSignedUrlApi/DeploymentStage.prod/Resource', [
            {
                id: 'AwsSolutions-APIG6',
                reason: 'Access logging is enabled at the stage level.'
            },
            {
                id: 'AwsSolutions-APIG3',
                reason: 'WAF is not required for this API in this solution.'
            }
        ]);

        NagSuppressions.addResourceSuppressionsByPath(this, '/VodFoundation/GetSignedUrlApi/Resource', [
            {
                id: 'AwsSolutions-APIG2',
                reason: 'Request validation is enabled via defaultMethodOptions.'
            }
        ]);

        // 8. CloudFront Distribution (with OAC)
        const apiOrigin = new HttpOrigin(
            cdk.Fn.select(2, cdk.Fn.split('/', api.url)), { originPath: '/prod' }
        );
        const s3Origin = new S3Origin(destination);

        const distribution = new cloudfront.Distribution(this, 'YogiflixDistribution', {
            defaultBehavior: {
                origin: apiOrigin,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
                originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
            },
            additionalBehaviors: {
                '*.m3u8': {
                    origin: s3Origin,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
                    originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
                    trustedKeyGroups: [keyGroup],
                },
                '*.ts': {
                    origin: s3Origin,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
                    originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
                    trustedKeyGroups: [keyGroup],
                },
                '*.jpg': {
                    origin: s3Origin,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
                    originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
                    trustedKeyGroups: [keyGroup],
                }
            },
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
            enableLogging: true,
            logBucket: logsBucket,
            logFilePrefix: 'cloudfront-logs/',
            comment: `${cdk.Aws.STACK_NAME} Video on Demand Foundation`
        });

        // Attach OAC to the S3 origin in the distribution
        const cfnDistribution = distribution.node.defaultChild as cloudfront.CfnDistribution;
        // Patch the S3 origin with OAC by overriding the CloudFormation property
        const origins = (cfnDistribution as any).origins ?? (cfnDistribution as any)._origins;
        if (origins) {
            const s3OriginIndex = origins.findIndex((origin: any) =>
                origin.domainName === destination.bucketRegionalDomainName
            );
            if (s3OriginIndex !== -1) {
                // Add the originAccessControlId property using addOverride
                cfnDistribution.addOverride(`Properties.Origins.${s3OriginIndex}.OriginAccessControlId`, oac.attrId);
            }
        }

        // 9. S3 Bucket Policy for OAC
        destination.addToResourcePolicy(new iam.PolicyStatement({
            actions: ['s3:GetObject'],
            resources: [destination.arnForObjects('*')],
            principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
            conditions: {
                StringEquals: {
                    'AWS:SourceArn': `arn:aws:cloudfront::${cdk.Aws.ACCOUNT_ID}:distribution/${distribution.distributionId}`
                }
            }
        }));

        // 10. Nag Suppressions (add as needed)
        NagSuppressions.addResourceSuppressions(
            distribution,
            [
                {
                    id: 'AwsSolutions-CFR1',
                    reason: 'Geo restriction is not required for this solution.'
                },
                {
                    id: 'AwsSolutions-CFR2',
                    reason: 'WAF is not required for this solution.'
                },
                {
                    id: 'AwsSolutions-CFR4',
                    reason: 'CloudFront default certificate does not support enforcing TLSv1.2. Custom ACM certificate required for compliance.'
                },
                {
                    id: 'AwsSolutions-CFR7',
                    reason: 'The CloudFront distribution does not use an origin access control with an S3 origin. Origin access controls help with security by restricting any direct access to objects through S3 URLs'
                }
            ]
        );

        /**
         * MediaConvert Service Role to grant Mediaconvert Access to the source and Destination Bucket,
         * API invoke * is also required for the services.
        */
        const mediaconvertRole = new iam.Role(this, 'MediaConvertRole', {
            assumedBy: new iam.ServicePrincipal('mediaconvert.amazonaws.com'),
        });
        const mediaconvertPolicy = new iam.Policy(this, 'MediaconvertPolicy', {
            statements: [
                new iam.PolicyStatement({
                    resources: [`${source.bucketArn}/*`, `${destination.bucketArn}/*`],
                    actions: ['s3:GetObject', 's3:PutObject']
                }),
                new iam.PolicyStatement({
                    resources: [`arn:${cdk.Aws.PARTITION}:execute-api:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:*`],
                    actions: ['execute-api:Invoke']
                })
            ]
        });
        mediaconvertPolicy.attachToRole(mediaconvertRole);
        //cdk_nag
        NagSuppressions.addResourceSuppressions(
            mediaconvertPolicy,
            [
                {
                    id: 'AwsSolutions-IAM5',
                    reason: '/* required to get/put objects to S3'
                }
            ]
        );
        /**
         * Custom Resource, Role and Policy.
         */
        const customResourceRole = new iam.Role(this, 'CustomResourceRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
        });

        const customResourcePolicy = new iam.Policy(this, 'CustomResourcePolicy', {
            statements: [
                new iam.PolicyStatement({
                    actions: ["s3:PutObject","s3:PutBucketNotification"],
                    resources: [source.bucketArn, `${source.bucketArn}/*`]
                }),
                new iam.PolicyStatement({
                    actions: ["mediaconvert:DescribeEndpoints"],
                    resources: [`arn:aws:mediaconvert:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:*`],
                }),
                new iam.PolicyStatement({
                    actions: [
                        "logs:CreateLogGroup",
                        "logs:CreateLogStream",
                        "logs:PutLogEvents"
                    ],
                    resources: ['*'],
                })
            ]
        });
        customResourcePolicy.attachToRole(customResourceRole);

        //cdk_nag
        addResourceSuppressions(
            customResourcePolicy,
            [
                {
                    id: [ 'AwsSolutions-IAM5', 'W12' ],
                    reason: 'Resource ARNs are not generated at the time of policy creation'
                }
            ]
        );

        const customResourceLambda = new lambda.Function(this, 'CustomResource', {
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'index.handler',
            description: 'CFN Custom resource to copy assets to S3 and get the MediaConvert endpoint',
            environment: {
                SOLUTION_IDENTIFIER: `AwsSolution/${solutionId}/${solutionVersion}`
            },
            code: lambda.Code.fromAsset('../custom-resource'),
            timeout: cdk.Duration.seconds(30),
            role: customResourceRole
        });
        customResourceLambda.node.addDependency(customResourcePolicy);
        customResourceLambda.node.addDependency(customResourceRole);
        /** get the cfn resource for the role and attach cfn_nag rule */
        const cfnCustomResource = customResourceLambda.node.findChild('Resource') as lambda.CfnFunction;
        cfnCustomResource.cfnOptions.metadata = {
            cfn_nag: {
                rules_to_suppress: [{
                    id: 'W58',
                    reason: 'Invalid warning: function has access to cloudwatch'
                },
                {
                    id: 'W89',
                    reason: 'Invalid warning: lambda not needed in VPC'
                },
                {
                    id: 'W92',
                    reason: 'Invalid warning: lambda does not need ReservedConcurrentExecutions'
                }]
            }
        };
        /**
         * Call the custom resource, this will return the MediaConvert endpoint and a UUID
        */
        const customResourceEndpoint = new cdk.CustomResource(this, 'Endpoint', {
            serviceToken: customResourceLambda.functionArn
        });

        /**
         * Job submit Lambda function, triggered by S3 Put events in the source S3 bucket
        */
        const jobSubmitRole = new iam.Role(this, 'JobSubmitRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
        });
        const jobSubmitPolicy = new iam.Policy(this, 'JobSubmitPolicy', {
            statements: [
                new iam.PolicyStatement({
                    actions: ["iam:PassRole"],
                    resources: [mediaconvertRole.roleArn]
                }),
                new iam.PolicyStatement({
                    actions: ["mediaconvert:CreateJob"],
                    resources: [`arn:${cdk.Aws.PARTITION}:mediaconvert:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:*`]
                }),
                new iam.PolicyStatement({
                    actions: ["s3:GetObject", "s3:ListBucket"],
                    resources: [source.bucketArn, `${source.bucketArn}/*`]
                }),
                new iam.PolicyStatement({
                    actions: [
                        "logs:CreateLogGroup",
                        "logs:CreateLogStream",
                        "logs:PutLogEvents"
                    ],
                    resources: ['*'],
                })
            ]
        });
        jobSubmitPolicy.attachToRole(jobSubmitRole);
        //cdk_nag
        addResourceSuppressions(
            jobSubmitPolicy,
            [
                {
                    id: [ 'AwsSolutions-IAM5', 'W12' ],
                    reason: 'Resource ARNs are not generated at the time of policy creation'
                }
            ]
        );

        const jobSubmit = new lambda.Function(this, 'jobSubmit', {
            code: lambda.Code.fromAsset(`../job-submit`),
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'index.handler',
            timeout: cdk.Duration.seconds(30),
            retryAttempts:0,
            description: 'Submits an Encoding job to MediaConvert',
            environment: {
                MEDIACONVERT_ENDPOINT: customResourceEndpoint.getAttString('Endpoint'),
                MEDIACONVERT_ROLE: mediaconvertRole.roleArn,
                JOB_SETTINGS: 'job-settings.json',
                DESTINATION_BUCKET: destination.bucketName,
                SOLUTION_ID: solutionId,
                STACKNAME: cdk.Aws.STACK_NAME,
                SOLUTION_IDENTIFIER: `AwsSolution/${solutionId}/${solutionVersion}`
                /** SNS_TOPIC_ARN: added by the solution construct below */
            },
            role: jobSubmitRole
        });
        jobSubmit.node.addDependency(jobSubmitPolicy);
        jobSubmit.node.addDependency(jobSubmitRole);

        /** Give S3 permission to trigger the job submit lambda function  */
        jobSubmit.addPermission('S3Trigger', {
            principal: new iam.ServicePrincipal('s3.amazonaws.com'),
            action: 'lambda:InvokeFunction',
            sourceAccount: cdk.Aws.ACCOUNT_ID
        });
        /** get the cfn resource for the role and attach cfn_nag rule */
        const cfnJobSubmit = jobSubmit.node.findChild('Resource') as lambda.CfnFunction;
        cfnJobSubmit.cfnOptions.metadata = {
            cfn_nag: {
                rules_to_suppress: [{
                    id: 'W58',
                    reason: 'Invalid warning: function has access to cloudwatch'
                },
                {
                    id: 'W89',
                    reason: 'Invalid warning: lambda not needed in VPC'
                },
                {
                    id: 'W92',
                    reason: 'Invalid warning: lambda does not need ReservedConcurrentExecutions'
                }]
            }
        };
        /**
         * Process outputs lambda function, invoked by EventBridge for MediaConvert.
         * Parses the event outputs, creates the CloudFront URLs for the outputs, updates
         * a manifest file in the destination bucket and send an SNS notfication.
         * Enviroment variables for the destination bucket and SNS topic are added by the
         *  solutions constructs
         */
        const jobCompleteRole = new iam.Role(this, 'JobCompleteRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
        });
        const jobCompletePolicy = new iam.Policy(this, 'JobCompletePolicy', {
            statements: [
                new iam.PolicyStatement({
                    actions: ["mediaconvert:GetJob"],
                    resources: [`arn:${cdk.Aws.PARTITION}:mediaconvert:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:*`]
                }),
                new iam.PolicyStatement({
                    actions: ["s3:GetObject", "s3:PutObject"],
                    resources: [`${source.bucketArn}/*`]
                }),
                new iam.PolicyStatement({
                    actions: [
                        "logs:CreateLogGroup",
                        "logs:CreateLogStream",
                        "logs:PutLogEvents"
                    ],
                    resources: ['*'],
                })
            ]
        });
        jobCompletePolicy.attachToRole(jobCompleteRole);
        //cdk_nag
        addResourceSuppressions(
            jobCompletePolicy,
            [
                {
                    id: [ 'AwsSolutions-IAM5', 'W12' ],
                    reason: 'Resource ARNs are not generated at the time of policy creation'
                }
            ]
        );

        const jobComplete = new lambda.Function(this, 'JobComplete', {
            code: lambda.Code.fromAsset(`../job-complete`),
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'index.handler',
            timeout: cdk.Duration.seconds(30),
            retryAttempts:0,
            description: 'Triggered by EventBridge,processes completed MediaConvert jobs.',
            environment: {
                MEDIACONVERT_ENDPOINT: customResourceEndpoint.getAttString('Endpoint'),
                CLOUDFRONT_DOMAIN: distribution.distributionDomainName,
                /** SNS_TOPIC_ARN: added by the solution construct below */
                SOURCE_BUCKET: source.bucketName,
                JOB_MANIFEST: 'jobs-manifest.json',
                STACKNAME: cdk.Aws.STACK_NAME,
                METRICS:  sendMetrics.findInMap('AnonymizedUsage', 'Data'),
                SOLUTION_ID: solutionId,
                VERSION:solutionVersion,
                UUID:customResourceEndpoint.getAttString('UUID'),
                SOLUTION_IDENTIFIER: `AwsSolution/${solutionId}/${solutionVersion}`
            },
            role: jobCompleteRole
        });
        jobComplete.node.addDependency(jobCompletePolicy);
        jobComplete.node.addDependency(jobCompleteRole);

        const cfnJobComplete = jobComplete.node.findChild('Resource') as lambda.CfnFunction;
        cfnJobComplete.cfnOptions.metadata = {
            cfn_nag: {
                rules_to_suppress: [{
                    id: 'W58',
                    reason: 'Invalid warning: function has access to cloudwatch'
                },
                {
                    id: 'W89',
                    reason: 'Invalid warning: lambda not needed in VPC'
                },
                {
                    id: 'W92',
                    reason: 'Invalid warning: lambda does not need ReservedConcurrentExecutions'
                }]
            }
        };
        /**
         * Custom resource to configure the source S3 bucket; upload default job-settings file and 
         * enabble event notifications to trigger the job-submit lambda function
         */
        new cdk.CustomResource(this, 'S3Config', { // NOSONAR
            serviceToken: customResourceLambda.functionArn,
            properties: {
                SourceBucket: source.bucketName,
                LambdaArn: jobSubmit.functionArn
            }
        });
        /**
         * Solution constructs, creates a EventBridge rule to trigger the process
         * outputs lambda functions.
         */
        new EventbridgeToLambda(this, 'EventTrigger', { // NOSONAR
            existingLambdaObj: jobComplete,
            eventRuleProps: {
                enabled: true,
                eventPattern: {
                    "source": ["aws.mediaconvert"],
                    "detail": {
                        "userMetadata": {
                            "StackName": [
                                cdk.Aws.STACK_NAME
                            ]
                        },
                        "status": [
                            "COMPLETE",
                            "ERROR",
                            "CANCELED",
                            "INPUT_INFORMATION"
                        ]
                    }
                }
            }
        });
        /**
         * Solutions construct, creates an SNS topic and a Lambda function  with permission
         * to publish messages to the topic. Also adds the SNS topic to the lambda Enviroment
         * varribles
        */
        const snsTopic = new LambdaToSns(this, 'Notification', {
            existingLambdaObj: jobSubmit
        });
        new LambdaToSns(this, 'CompleteSNS', { // NOSONAR
            existingLambdaObj: jobComplete,
            existingTopicObj: snsTopic.snsTopic
        });
        /**
         * Subscribe the admin email address to the SNS topic created but the construct.
         */
        snsTopic.snsTopic.addSubscription(new subs.EmailSubscription(adminEmail.valueAsString))

        /**
        * AppRegistry
        */
        const applicationName = `vod-foundation-${cdk.Aws.REGION}-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.STACK_NAME}`;
        const attributeGroup = new appreg.AttributeGroup(this, 'AppRegistryAttributeGroup', {
            attributeGroupName: `${cdk.Aws.REGION}-${cdk.Aws.STACK_NAME}`,
            description: "Attribute group for solution information.",
            attributes: {
                ApplicationType: 'AWS-Solutions',
                SolutionVersion: solutionVersion,
                SolutionID: solutionId,
                SolutionName: solutionName
            }
        });
        const appRegistry = new appreg.Application(this, 'AppRegistryApp', {
            applicationName: applicationName,
            description: `Service Catalog application to track and manage all your resources. The SolutionId is ${solutionId} and SolutionVersion is ${solutionVersion}.`
        });
        appRegistry.associateApplicationWithStack(this);
        cdk.Tags.of(appRegistry).add('Solutions:SolutionID', solutionId);
        cdk.Tags.of(appRegistry).add('Solutions:SolutionName', solutionName);
        cdk.Tags.of(appRegistry).add('Solutions:SolutionVersion', solutionVersion);
        cdk.Tags.of(appRegistry).add('Solutions:ApplicationType', 'AWS-Solutions');

        attributeGroup.associateWith(appRegistry);

        /**
         * Stack Outputs
        */
        new cdk.CfnOutput(this, 'SourceBucket', { // NOSONAR
            value: source.bucketName,
            description: 'Source S3 Bucket used to host source video and MediaConvert job settings files',
            exportName: `${ cdk.Aws.STACK_NAME}-SourceBucket`
        });
        new cdk.CfnOutput(this, 'DestinationBucket', { // NOSONAR
            value: destination.bucketName,
            description: 'Source S3 Bucket used to host all MediaConvert ouputs',
            exportName: `${ cdk.Aws.STACK_NAME}-DestinationBucket`
        });
        new cdk.CfnOutput(this, 'CloudFrontDomain', { // NOSONAR
            value: distribution.distributionDomainName,
            description: 'CloudFront Domain Name',
            exportName: `${ cdk.Aws.STACK_NAME}-CloudFrontDomain`
        });
        new cdk.CfnOutput(this, 'SnsTopic', { // NOSONAR
            value: snsTopic.snsTopic.topicName,
            description: 'SNS Topic used to capture the VOD workflow outputs including errors',
            exportName: `${ cdk.Aws.STACK_NAME}-SnsTopic`
        });
    }
}

/**
 * Interface for creating a rule suppression
 */
interface NagSuppressionRules {
    /**
     * The id or array of IDs of the CDK or CFN rule or rules to ignore
     */
    readonly id: string | string[];
    /**
     * The reason to ignore the rule (minimum 10 characters)
     */
    readonly reason: string;
}

/**
 * Interface for creating a rule suppression
 */
interface NagSuppressionRule {
    /**
     * The id of the CDK or CFN rule to ignore
     */
    readonly id: string
    /**
     * The reason to ignore the rule (minimum 10 characters)
     */
    readonly reason: string;
}

/**
 * Add CFN and/or CDK NAG rule suppressions to resources.
 */
function addResourceSuppressions(resource: cdk.IResource | cdk.CfnResource, rules: NagSuppressionRules[]): void {
    // Separate CDK Nag rules from CFN Nag rules.
    const cdkRules: NagSuppressionRule[] = [];
    const cfnRules: NagSuppressionRule[] = [];
    for (const rule of rules) {
        for (const id of (Array.isArray(rule.id) ? rule.id : [rule.id])) {
            const nagRules = id.startsWith("AwsSolutions-") ? cdkRules : cfnRules;
            nagRules.push({ id, reason: rule.reason });
        }
    }

    // Add any CDK Nag rules that were found.
    if (cdkRules.length > 0) {
        NagSuppressions.addResourceSuppressions(resource, cdkRules);
    }

    // Add any CFN Nag rules that were found.
    if (cfnRules.length > 0) {
        // Get at the L1 construct for a CFN Resource.
        const cfn: cdk.CfnResource = resource instanceof cdk.CfnResource
            ? resource
            : resource.node.defaultChild as cdk.CfnResource;

        // Get the metadata object for CFN Nag rule suppressions.
        const metadata = cfn.getMetadata('cfn_nag') ?? {};
        // Concatenate new rules with existing rules if there are any.
        metadata.rules_to_suppress = [ ...(metadata.rules_to_suppress ?? []), ...cfnRules ];
        // Add the metadata object to the resource.
        cfn.addMetadata('cfn_nag', metadata);
    }
}
