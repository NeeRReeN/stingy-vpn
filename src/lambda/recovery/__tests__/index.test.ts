import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock AWS SDK clients before any imports
const mockEc2Send = vi.fn();
const mockSsmSend = vi.fn();

vi.mock("@aws-sdk/client-ec2", () => ({
  EC2Client: vi.fn(() => ({ send: mockEc2Send })),
  RunInstancesCommand: vi.fn((input: unknown) => ({ input })),
  DescribeInstancesCommand: vi.fn((input: unknown) => ({ input })),
}));

vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: vi.fn(() => ({ send: mockSsmSend })),
  GetParameterCommand: vi.fn((input: unknown) => ({ input })),
  PutParameterCommand: vi.fn((input: unknown) => ({ input })),
}));

// Set env vars before module load
const TEST_ENV = {
  PARAMETER_STORE_PREFIX: "/stingy-vpn/test",
  SUBNET_ID: "subnet-12345",
  LAUNCH_TEMPLATE_ID: "lt-12345",
  LOG_LEVEL: "error", // suppress log output in tests
};

function createEvent(instanceId: string) {
  return {
    version: "0",
    id: "test-event-id",
    source: "aws.ec2",
    account: "123456789012",
    time: "2024-01-01T00:00:00Z",
    region: "ap-northeast-1",
    resources: [],
    "detail-type": "EC2 Spot Instance Interruption Warning" as const,
    detail: {
      "instance-id": instanceId,
      "instance-action": "terminate",
    },
  };
}

const mockContext = {
  awsRequestId: "test-request-id",
  functionName: "test-function",
  functionVersion: "$LATEST",
  invokedFunctionArn: "arn:aws:lambda:ap-northeast-1:123456789012:function:test",
  memoryLimitInMB: "256",
  logGroupName: "/aws/lambda/test",
  logStreamName: "test-stream",
  callbackWaitsForEmptyEventLoop: true,
  getRemainingTimeInMillis: () => 300000,
  done: () => {},
  fail: () => {},
  succeed: () => {},
} as unknown as import("aws-lambda").Context;

describe("Recovery Lambda Handler", () => {
  beforeEach(() => {
    vi.resetModules();
    mockEc2Send.mockReset();
    mockSsmSend.mockReset();

    // Set environment variables
    for (const [key, value] of Object.entries(TEST_ENV)) {
      process.env[key] = value;
    }
  });

  async function importHandler() {
    const mod = await import("../index.js");
    return mod.handler;
  }

  it("should ignore event when instance ID parameter is 'initial'", async () => {
    mockSsmSend.mockResolvedValueOnce({
      Parameter: { Value: "initial" },
    });

    const handler = await importHandler();
    await handler(createEvent("i-interrupted"), mockContext);

    // Should have called SSM GetParameter but NOT EC2 RunInstances
    expect(mockSsmSend).toHaveBeenCalledTimes(1);
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  it("should ignore event for unmanaged instance", async () => {
    mockSsmSend.mockResolvedValueOnce({
      Parameter: { Value: "i-managed-instance" },
    });

    const handler = await importHandler();
    await handler(createEvent("i-different-instance"), mockContext);

    // Should have called SSM but NOT EC2
    expect(mockSsmSend).toHaveBeenCalledTimes(1);
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  it("should launch new instance when managed instance is interrupted", async () => {
    const managedInstanceId = "i-managed-instance";
    const newInstanceId = "i-new-instance";

    // GetParameter returns managed instance ID
    mockSsmSend.mockResolvedValueOnce({
      Parameter: { Value: managedInstanceId },
    });
    // PutParameter succeeds
    mockSsmSend.mockResolvedValueOnce({});

    // RunInstances returns new instance
    mockEc2Send.mockResolvedValueOnce({
      Instances: [{ InstanceId: newInstanceId }],
    });
    // DescribeInstances returns running state
    mockEc2Send.mockResolvedValueOnce({
      Reservations: [
        { Instances: [{ State: { Name: "running" } }] },
      ],
    });

    const handler = await importHandler();
    await handler(createEvent(managedInstanceId), mockContext);

    // Should call SSM twice (get + put) and EC2 twice (run + describe)
    expect(mockSsmSend).toHaveBeenCalledTimes(2);
    expect(mockEc2Send).toHaveBeenCalledTimes(2);
  });

  it("should throw when RunInstances fails", async () => {
    const managedInstanceId = "i-managed-instance";

    mockSsmSend.mockResolvedValueOnce({
      Parameter: { Value: managedInstanceId },
    });
    mockEc2Send.mockRejectedValueOnce(new Error("EC2 API error"));

    const handler = await importHandler();
    await expect(
      handler(createEvent(managedInstanceId), mockContext),
    ).rejects.toThrow("EC2 API error");
  });

  it("should throw when instance enters terminated state during wait", async () => {
    const managedInstanceId = "i-managed-instance";
    const newInstanceId = "i-new-instance";

    mockSsmSend.mockResolvedValueOnce({
      Parameter: { Value: managedInstanceId },
    });
    mockSsmSend.mockResolvedValueOnce({});

    mockEc2Send.mockResolvedValueOnce({
      Instances: [{ InstanceId: newInstanceId }],
    });
    mockEc2Send.mockResolvedValueOnce({
      Reservations: [
        { Instances: [{ State: { Name: "terminated" } }] },
      ],
    });

    const handler = await importHandler();
    await expect(
      handler(createEvent(managedInstanceId), mockContext),
    ).rejects.toThrow("Instance entered terminal state: terminated");
  });
});
