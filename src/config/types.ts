/**
 * Common type definitions for stingy-vpn project
 */

// Environment type
export type Environment = "dev" | "prod";

// WireGuard configuration
export interface WireGuardConfig {
  readonly serverPrivateKey: string;
  readonly serverPublicKey: string;
  readonly serverAddress: string;
  readonly listenPort: number;
  readonly peers: WireGuardPeer[];
}

export interface WireGuardPeer {
  readonly name: string;
  readonly publicKey: string;
  readonly allowedIPs: string[];
}

// AWS resource configuration
export interface VpnStackConfig {
  readonly environment: Environment;
  readonly ec2InstanceType: string;
  readonly vpcCidr: string;
  readonly subnetCidr: string;
  readonly wireguardPort: number;
  readonly wireguardSubnet: string;
}

// Cloudflare configuration
export interface CloudflareConfig {
  readonly zoneId: string;
  readonly recordId: string;
  readonly recordName: string;
}

// Parameter Store paths
export interface ParameterStorePaths {
  readonly instanceId: string;
  readonly cloudflareToken: string;
  readonly cloudflareZoneId: string;
  readonly cloudflareRecordId: string;
  readonly wireguardPrivateKey: string;
  readonly wireguardConfig: string;
  readonly launchTemplateId: string;
}

// Lambda environment variables
export interface RecoveryLambdaEnv {
  readonly PARAMETER_STORE_PREFIX: string;
  readonly LOG_LEVEL: string;
  readonly VPC_ID: string;
  readonly SUBNET_ID: string;
  readonly SECURITY_GROUP_ID: string;
  readonly LAUNCH_TEMPLATE_ID: string;
}

export interface DdnsUpdaterLambdaEnv {
  readonly PARAMETER_STORE_PREFIX: string;
  readonly CLOUDFLARE_ZONE_ID: string;
  readonly CLOUDFLARE_RECORD_ID: string;
  readonly LOG_LEVEL: string;
}

// EventBridge event types
export interface SpotInterruptionDetail {
  readonly "instance-id": string;
  readonly "instance-action": string;
}

export interface Ec2StateChangeDetail {
  readonly "instance-id": string;
  readonly state: string;
}

// Operation result type
export type OperationResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: Error };

// Cloudflare API types
export interface CloudflareApiResponse<T> {
  readonly success: boolean;
  readonly errors: CloudflareApiError[];
  readonly messages: string[];
  readonly result: T;
}

export interface CloudflareApiError {
  readonly code: number;
  readonly message: string;
}

export interface CloudflareDnsRecord {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly content: string;
  readonly ttl: number;
  readonly proxied: boolean;
}

// Default configuration values
export const DEFAULT_CONFIG = {
  wireguardPort: 51820,
  wireguardSubnet: "10.0.0.0/24",
  vpcCidr: "10.0.0.0/16",
  subnetCidr: "10.0.1.0/24",
  ec2InstanceType: "t4g.nano",
} as const;
