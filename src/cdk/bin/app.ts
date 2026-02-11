#!/usr/bin/env npx ts-node --esm

import * as cdk from "aws-cdk-lib";

import { StingyVpnStack } from "../lib/stingy-vpn-stack.js";

const app = new cdk.App();

// Get configuration from context or environment
const environment = (app.node.tryGetContext("environment") ?? "dev") as
  | "dev"
  | "prod";
const cloudflareZoneId =
  app.node.tryGetContext("cloudflareZoneId") ??
  process.env.CLOUDFLARE_ZONE_ID ??
  "";
const cloudflareRecordId =
  app.node.tryGetContext("cloudflareRecordId") ??
  process.env.CLOUDFLARE_RECORD_ID ??
  "";

// Validate required configuration
if (!cloudflareZoneId || !cloudflareRecordId) {
  console.warn(
    "Warning: Cloudflare configuration not provided. " +
      "Set cloudflareZoneId and cloudflareRecordId via context or environment variables."
  );
}

// Create the stack
new StingyVpnStack(app, `StingyVpnStack-${environment}`, {
  environment,
  cloudflareZoneId,
  cloudflareRecordId,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "ap-northeast-1",
  },
  description: `Stingy VPN - Low-cost VPN solution using EC2 Spot Instances (${environment})`,
});

app.synth();
