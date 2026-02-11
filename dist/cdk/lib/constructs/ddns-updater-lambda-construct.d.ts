import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import type { Environment } from "../../../config/types.js";
export interface DdnsUpdaterLambdaConstructProps {
    /** Environment (dev/prod) */
    readonly environment: Environment;
    /** Parameter Store prefix */
    readonly parameterStorePrefix: string;
    /** Cloudflare Zone ID */
    readonly cloudflareZoneId: string;
    /** Cloudflare DNS Record ID */
    readonly cloudflareRecordId: string;
}
/**
 * DDNS Updater Lambda Construct
 * Updates Cloudflare DNS record with the new EC2 public IP
 */
export declare class DdnsUpdaterLambdaConstruct extends Construct {
    readonly function: lambda.Function;
    constructor(scope: Construct, id: string, props: DdnsUpdaterLambdaConstructProps);
}
