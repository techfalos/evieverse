/** One secret of AWS Secrets Manager that a function reads its settings from, as FUNCTION_SECRETS names it. */
export interface SecretRef {
  /** The secret's ARN or name. */
  id: string;
  /** The version to read, by its id. Left out: the current one (`AWSCURRENT`), whatever it is when the instance starts. */
  version?: string;
}

/** The credentials a request to AWS is signed with: a Lambda function's are its role's, which Lambda puts in its environment. */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** What comes with a role's temporary credentials, and is sent with every request signed with them. */
  sessionToken?: string;
}

/** A call of AWS's JSON protocol, which is a POST to the root of a service's endpoint: what `signV4` signs. */
export interface AwsCall {
  /** The endpoint's host, with its port if it names one. */
  host: string;
  /** The service's name in a signature's scope: `secretsmanager`. */
  service: string;
  region: string;
  /** The headers to sign beside `host` and the ones the signature adds, with their names in lower case. */
  headers: Record<string, string>;
  body: string;
}

/** How `loadSecrets` reads the secrets, where it isn't from AWS's own endpoint, by the system's clock, and taking a refusal as final. */
export interface SecretsOptions {
  /** Where Secrets Manager is, as a URL. By default the region's own endpoint. Only tests give one. */
  endpoint?: string;
  /** Injectable clock (UTC epoch ms). Only tests give one. */
  now?: () => number;
  /**
   * For how long a secret that the role may not read is asked for again, before that is the
   * failure: 0 by default. The step a deploy runs first gives it, as the deploy may have granted
   * the permission seconds before, and IAM takes a moment to apply a grant everywhere.
   */
  permissionWaitMs?: number;
}
