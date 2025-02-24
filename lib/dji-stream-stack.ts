import { Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import {
  AwsLogDriver,
  Cluster,
  ContainerImage,
  CpuArchitecture,
  FargateTaskDefinition,
  OperatingSystemFamily,
  Protocol,
  FargateService,
} from "aws-cdk-lib/aws-ecs";
import { Repository } from "aws-cdk-lib/aws-ecr";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Peer, Port, SecurityGroup, Vpc } from "aws-cdk-lib/aws-ec2";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { HostedZone, ARecord, RecordTarget } from "aws-cdk-lib/aws-route53";
import {
  Protocol as ELBProtocol,
  TargetType,
  NetworkTargetGroup,
  NetworkLoadBalancer,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { Construct } from "constructs";
import { LoadBalancerTarget } from "aws-cdk-lib/aws-route53-targets";

export class SfDJIStreamStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Certificates and Hosted Zone
    // Lookup the existing hosted zone
    const hostedZone = HostedZone.fromLookup(this, "SfHostedZone", {
      domainName: "flyskyflow.com",
    });

    // VPC ---------------------------------------------------------------------- //
    const vpcId = StringParameter.valueFromLookup(this, "/skyflow-db/vpc-id");
    const vpc = Vpc.fromLookup(this, "ImportedSfDbVpc", {
      vpcId: vpcId,
    });

    // Security Group
    const securityGroup = new SecurityGroup(this, "SfDJIStreamSG", {
      vpc, // Use the existing imported VPC
      description: "Security group for DJI Streaming Server",
      allowAllOutbound: true, // Allow all outbound traffic by default
    });

    // ECS Cluster
    const cluster = new Cluster(this, "SfDJIStreamCluster", {
      vpc,
      containerInsights: true,
    });

    // ECR Repository
    const repository = Repository.fromRepositoryName(
      this,
      "SfDJIStreamRepository",
      "skyflow-dji-stream-server"
    );

    // Cloudwatch Logs
    const logging = new AwsLogDriver({
      streamPrefix: "sfDJIStream",
      logGroup: new LogGroup(this, "SfDJIStreamLogGroup", {
        retention: RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });

    // Fargate Task Definition
    const taskDefinition = new FargateTaskDefinition(
      this,
      "SfDJIStreamTaskDef",
      {
        memoryLimitMiB: 2048,
        cpu: 1024,
        runtimePlatform: {
          operatingSystemFamily: OperatingSystemFamily.LINUX,
          cpuArchitecture: CpuArchitecture.X86_64,
        },
      }
    );

    // Add container to task definition
    taskDefinition.addContainer("SfDJIStreamContainer", {
      containerName: "SfDJIStreamContainer",
      image: ContainerImage.fromEcrRepository(repository, "latest"),
      logging: logging,
      healthCheck: {
        command: ["CMD-SHELL", "curl -f http://localhost:80/ || exit 1"],
        interval: Duration.seconds(30), // Check every 30 seconds
        timeout: Duration.seconds(10), // Allow 10 seconds for the check
        startPeriod: Duration.seconds(60), // Give 60 seconds for initial startup
        retries: 3, // Allow 3 retries
      },
      // This is the port mapping from the container to the host
      portMappings: [
        { containerPort: 80, protocol: Protocol.TCP }, // For Nginx HTTP Server
        { containerPort: 1935, protocol: Protocol.TCP }, // For RTMP
      ],
      environment: {
        NGINX_WORKER_PROCESSES: "2",
        NGINX_WORKER_CONNECTIONS: "1024",
        RTMP_CHUNK_SIZE: "4096",
      },
    });

    // Create the load balancer first
    const lb = new NetworkLoadBalancer(this, "DJIStreamLoadBalancer", {
      vpc,
      internetFacing: true,
    });

    // Add DNS record for the load balancer
    new ARecord(this, "DJIStreamDNSRecord", {
      zone: hostedZone,
      recordName: "stream.flyskyflow.com",
      target: RecordTarget.fromAlias(new LoadBalancerTarget(lb)),
    });

    // Create the Fargate service without the load balancer
    const service = new FargateService(this, "DJIStreamService", {
      cluster,
      taskDefinition,
      desiredCount: 1,
      securityGroups: [securityGroup],
    });

    // Add required inbound rules
    const djiStreamPorts = [
      { port: 80, description: "Nginx HTTP Server", protocol: ELBProtocol.TCP },
      { port: 1935, description: "RTMP", protocol: ELBProtocol.TCP },
    ];

    djiStreamPorts.forEach(({ port, description, protocol }) => {
      // Allow inbound from anywhere on the container port
      securityGroup.addIngressRule(
        Peer.anyIpv4(),
        Port.tcp(port),
        `Allow ${description} traffic`
      );
    });

    // Create target groups and listeners
    // This is the port mapping from the load balancer to the container host
    // Kinda like a port forwarding
    djiStreamPorts.forEach(({ port, protocol }) => {
      const targetGroup = new NetworkTargetGroup(this, `TargetGroup${port}`, {
        vpc,
        port,
        protocol,
        targetType: TargetType.IP,
        targets: [
          service.loadBalancerTarget({
            containerName: "SfDJIStreamContainer",
            containerPort: port,
          }),
        ],
      });

      if (port === 80) {
        targetGroup.configureHealthCheck({
          path: "/",
          port: port.toString(),
          protocol: ELBProtocol.HTTP,
          healthyHttpCodes: "200-399",
          interval: Duration.seconds(60),
          timeout: Duration.seconds(10),
        });
      }

      lb.addListener(`Listener${port}`, {
        port,
        protocol,
        defaultTargetGroups: [targetGroup],
      });
    });
  }
}
