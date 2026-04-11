import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock AWS SDK clients before any imports
const mockEc2Send = vi.fn();
const mockSsmSend = vi.fn();

vi.mock("@aws-sdk/client-ec2", () => ({
  EC2Client: vi.fn(() => ({ send: mockEc2Send })),
  DescribeInstancesCommand: vi.fn((input: unknown) => ({ input })),
}));

vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: vi.fn(() => ({ send: mockSsmSend })),
  GetParameterCommand: vi.fn((input: unknown) => ({ input })),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const TEST_ENV = {
  PARAMETER_STORE_PREFIX: "/stingy-vpn/test",
  CLOUDFLARE_ZONE_ID: "zone-123",
  CLOUDFLARE_RECORD_ID: "record-456",
  LOG_LEVEL: "error",
};

function createEvent(instanceId: string, state = "running") {
  return {
    version: "0",
    id: "test-event-id",
    source: "aws.ec2",
    account: "123456789012",
    time: "2024-01-01T00:00:00Z",
    region: "ap-northeast-1",
    resources: [],
    "detail-type": "EC2 Instance State-change Notification" as const,
    detail: {
      "instance-id": instanceId,
      state,
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
  getRemainingTimeInMillis: () => 120000,
  done: () => {},
  fail: () => {},
  succeed: () => {},
} as unknown as import("aws-lambda").Context;

describe("DDNS Updater Lambda Handler", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    mockEc2Send.mockReset();
    mockSsmSend.mockReset();
    mockFetch.mockReset();

    for (const [key, value] of Object.entries(TEST_ENV)) {
      process.env[key] = value;
    }
  });

  async function importHandler() {
    const mod = await import("../index.js");
    return mod.handler;
  }

  it("should ignore non-running state events", async () => {
    const handler = await importHandler();
    await handler(createEvent("i-12345", "stopped"), mockContext);

    // Should not call any AWS API
    expect(mockSsmSend).not.toHaveBeenCalled();
    expect(mockEc2Send).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("should ignore event for unmanaged instance", async () => {
    // GetParameter returns a different managed instance
    mockSsmSend.mockResolvedValueOnce({
      Parameter: { Value: "i-managed-instance" },
    });

    const handler = await importHandler();
    await handler(createEvent("i-different-instance"), mockContext);

    expect(mockSsmSend).toHaveBeenCalledTimes(1);
    expect(mockEc2Send).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("should update DNS when managed instance enters running state", async () => {
    const instanceId = "i-managed-instance";
    const publicIp = "203.0.113.42";

    // GetParameter: instance-id
    mockSsmSend.mockResolvedValueOnce({
      Parameter: { Value: instanceId },
    });

    // DescribeInstances returns public IP
    mockEc2Send.mockResolvedValueOnce({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: instanceId,
              PublicIpAddress: publicIp,
            },
          ],
        },
      ],
    });

    // GetParameter: cloudflare-token (called inside updateCloudflareRecord)
    mockSsmSend.mockResolvedValueOnce({
      Parameter: { Value: "cf-api-token" },
    });

    // Cloudflare API response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        errors: [],
        messages: [],
        result: {
          id: "record-456",
          type: "A",
          name: "vpn.example.com",
          content: publicIp,
          ttl: 1,
          proxied: false,
        },
      }),
    });

    const handler = await importHandler();
    await handler(createEvent(instanceId), mockContext);

    expect(mockSsmSend).toHaveBeenCalledTimes(2);
    expect(mockEc2Send).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Verify Cloudflare API call
    const fetchCall = mockFetch.mock.calls[0];
    expect(fetchCall[0]).toContain("api.cloudflare.com");
    expect(fetchCall[0]).toContain("zone-123");
    expect(fetchCall[0]).toContain("record-456");
    expect(fetchCall[1].method).toBe("PATCH");
    expect(JSON.parse(fetchCall[1].body as string)).toEqual({
      content: publicIp,
    });
  });

  it("should throw when Cloudflare API returns error status", async () => {
    const instanceId = "i-managed-instance";

    // GetParameter: instance-id
    mockSsmSend.mockResolvedValueOnce({
      Parameter: { Value: instanceId },
    });

    // DescribeInstances returns public IP
    mockEc2Send.mockResolvedValueOnce({
      Reservations: [
        {
          Instances: [
            { InstanceId: instanceId, PublicIpAddress: "1.2.3.4" },
          ],
        },
      ],
    });

    // GetParameter: cloudflare-token (called by updateCloudflareRecord on each retry)
    mockSsmSend.mockResolvedValue({
      Parameter: { Value: "cf-api-token" },
    });

    // Cloudflare API returns error on all retries
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "Forbidden",
    });

    // Make setTimeout resolve immediately to speed up retries
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    const handler = await importHandler();

    await expect(
      handler(createEvent(instanceId), mockContext),
    ).rejects.toThrow("Cloudflare API error: 403");
  });

  it("should throw when instance has no public IP", async () => {
    const instanceId = "i-managed-instance";

    // GetParameter: instance-id
    mockSsmSend.mockResolvedValueOnce({
      Parameter: { Value: instanceId },
    });

    // DescribeInstances returns instance without public IP (all retries)
    mockEc2Send.mockResolvedValue({
      Reservations: [
        {
          Instances: [
            { InstanceId: instanceId, PublicIpAddress: undefined },
          ],
        },
      ],
    });

    // Make setTimeout resolve immediately to speed up retries
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    const handler = await importHandler();

    await expect(
      handler(createEvent(instanceId), mockContext),
    ).rejects.toThrow("does not have a public IP");
  });
});
