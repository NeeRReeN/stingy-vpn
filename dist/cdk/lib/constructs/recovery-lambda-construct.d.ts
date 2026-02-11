import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import type { Environment } from "../../../config/types.js";
export interface RecoveryLambdaConstructProps {
    /** Environment (dev/prod) */
    readonly environment: Environment;
    /** Parameter Store prefix */
    readonly parameterStorePrefix: string;
    /** VPC ID for EC2 operations */
    readonly vpcId: string;
    /** Subnet ID for spot instance launch */
    readonly subnetId: string;
    /** Security group ID for spot instance */
    readonly securityGroupId: string;
    /** Launch template ID */
    readonly launchTemplateId: string;
    /** EC2 instance role ARN (for iam:PassRole restriction) */
    readonly ec2RoleArn: string;
}
/**
 * Recovery Lambda Construct
 * Handles spot instance interruption and launches a new instance
 */
export declare class RecoveryLambdaConstruct extends Construct {
    readonly function: lambda.Function;
    constructor(scope: Construct, id: string, props: RecoveryLambdaConstructProps);
}
