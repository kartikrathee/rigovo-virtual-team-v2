# EKS deployment with local GPU inference

The cloud runs one CPU-only coding-agent server; Ollama remains on your local
GPU machine. Cloudflare Tunnel plus Access connects them. Product naming and
the other projects' deployment are separate from these runtime/package names.
This setup is for a single trusted operator: agent tools execute code inside
the container. It is not a multi-tenant execution sandbox.

## Cost and availability

At AWS's published standard-support rate, EKS's control plane alone costs
$144 for 60 days (1440 hours × $0.10). EC2, EBS, public IPv4, DNS, ECR,
transfer and taxes are additional. This will exceed a $160 total budget.
The user explicitly selected EKS despite the additional cost. No GPU, NAT
gateway, load balancer or managed database is provisioned by these files.
Use AWS Budgets alerts; an alert does not cap spending. Check your credit's
expiration and eligible services in the AWS billing console.

The one-node configuration and Recreate deployment have downtime during node
failure and upgrades. Local inference stops when your machine sleeps, loses
connectivity or stops Ollama/cloudflared. No automatic paid GPU fallback exists.

Sources: [EKS pricing](https://aws.amazon.com/eks/pricing/),
[EBS CSI requirements](https://docs.aws.amazon.com/eks/latest/userguide/ebs-csi.html).

## Local checks before spending

From the repository root:

```sh
kubectl kustomize deploy/eks
docker build -f deploy/Dockerfile -t coding-agent:local .
docker run --rm coding-agent:local --version
```

GitHub's reusable `rigovo.yml` workflow runs package type checks, regression
tests, manifest rendering and a real container startup/health check. The manual
`deploy-eks.yml` workflow requires these jobs to pass before publishing to ECR.
It deploys the exact checked-out commit tagged by its Git SHA.

## Local GPU and authenticated tunnel

Keep Ollama bound to loopback. Create the model locally using the setup in the
root README. In Cloudflare Zero Trust, create a named tunnel with a public
hostname such as `inference.example.com` routed to `http://127.0.0.1:11434`.
Run its cloudflared connector on the GPU machine and enable it on boot.

Protect that exact hostname with an Access application and a **Service Auth**
policy allowing a dedicated service token. Confirm an unauthenticated request
is rejected before using the endpoint. The client sends the two headers documented
in [Cloudflare service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).
Test actual long inference streams through your Cloudflare plan; proxy timeouts
and streaming behavior may require tuning. Increasing the agent timeout cannot
override a Cloudflare timeout.

Create a local ignored `deploy/runtime.env` with mode 600 containing:

```dotenv
OPENCODE_SERVER_PASSWORD=REPLACE_WITH_A_RANDOM_PASSWORD
OLLAMA_OPENAI_URL=https://inference.example.com/v1
OLLAMA_TUNNEL_HOSTNAME=inference.example.com
CF_ACCESS_CLIENT_ID=REPLACE_WITH_SERVICE_TOKEN_ID
CF_ACCESS_CLIENT_SECRET=REPLACE_WITH_SERVICE_TOKEN_SECRET
RIGOVO_MODEL=qwen3-coder-32k:latest
RIGOVO_MAX_WORKERS=1
```

Use one worker initially to avoid overloading the local GPU. Never commit this
file or tunnel credentials. Runtime secrets are provisioned directly to Kubernetes;
the image and workflow contain no inference credentials.

## Provision the AWS cluster

Select your AWS profile and region first. Review `eks/cluster.yaml` and change its
example name and region. Provision deliberately using `eksctl create cluster -f
deploy/eks/cluster.yaml`. This is a billable operation. Use a currently supported
Kubernetes version and record the actual version for kubectl compatibility.

Install the standard Amazon EBS CSI add-on and grant its required IAM permissions
using the AWS EBS CSI instructions linked above. This StorageClass targets
standard EKS with EC2 managed nodes; it is not an EKS Auto Mode or Fargate setup.
Then run:

```sh
kubectl apply -f deploy/eks/storage-class.yaml
kubectl apply -f deploy/eks/namespace.yaml
kubectl -n coding-agent create secret generic agent-runtime --from-env-file=deploy/runtime.env
```

Create an ECR repository with immutable tags and a lifecycle policy retaining a
small number of releases. Ensure the node role can pull its images.

## GitHub OIDC and deployment

Create a GitHub `production` environment restricted to the deployment branch.
Set these environment variables: `AWS_REGION`, `EKS_CLUSTER`, `ECR_REPOSITORY`,
`AWS_ROLE_ARN`, and `KUBECTL_VERSION` (for example `v1.N.P`, matching the cluster).

Configure an IAM OIDC provider for `https://token.actions.githubusercontent.com`
with audience `sts.amazonaws.com`. Restrict the deploy role's trust to this
repository's **production environment** subject. Use the repository's actual
subject format: newer GitHub repositories can include immutable owner/repository
IDs. See [GitHub's AWS OIDC guide](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws).

The deploy role needs `ecr:GetAuthorizationToken` plus repository-scoped
`ecr:BatchCheckLayerAvailability`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`,
`ecr:CompleteLayerUpload`, `ecr:PutImage`, and `ecr:BatchGetImage`, and
`eks:DescribeCluster` on this cluster. Grant Kubernetes access through an EKS
access entry and namespace-scoped RBAC for deployments, services, PVCs and reading
the existing runtime secret. Pre-create the namespace as above and allow the
deployment role to get/patch that namespace only; `kubectl apply` includes it.
The deploy role does not create clusters, IAM roles or StorageClasses.

Run **Deploy coding agent to EKS** manually from the intended branch. The job
publishes the Git SHA image, applies the namespace manifests and waits for rollout.
Roll back with `kubectl -n coding-agent rollout undo deployment/coding-agent`;
this rolls back the image, not database migrations or workspace files. Keep tested
volume snapshots before upgrades. Re-running a published SHA requires reusing its
existing ECR image or a new commit because ECR tags are immutable.

## Domain names and AWS namespaces

The Kubernetes namespace `coding-agent` groups resources; it does not register
a domain. Route 53 hosted zones provide authoritative DNS; domain registration
is separate. With a Route 53 parent zone, delegate a dedicated subdomain to
Cloudflare using the nameservers supplied for the Cloudflare zone, subject to
your Cloudflare plan supporting that zone arrangement. Do not change nameservers
until the actual domain and existing records are known.

The agent Service is ClusterIP, avoiding a paid load balancer. Initially access it
with `kubectl -n coding-agent port-forward service/coding-agent 4096:4096` and
authenticate as `opencode` with the runtime password. For a public product hostname,
add a separate Cloudflare Tunnel connector in the cluster pointing to
`http://coding-agent.coding-agent.svc.cluster.local:4096`, protect it with Access,
and retain the server password. Tunnel/account/domain resources must be configured
for the actual account before public access is available.

## End of the hosting period

Set a calendar reminder for the two-month end date. Export workspace/session data,
take any desired snapshots, then delete the cluster using its reviewed eksctl
configuration. The StorageClass retains EBS data intentionally: inspect and delete
unneeded retained EBS volumes/snapshots, ECR images and hosted zones separately.
Stopping the app does not stop EKS control-plane charges.
