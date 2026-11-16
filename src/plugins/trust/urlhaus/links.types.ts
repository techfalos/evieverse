/** A web address as it is compared: without its scheme, so http and https are one, and without its fragment. */
export interface Address {
  /** Its host, with its port unless that is the scheme's own: example.com, 192.0.2.1:8080. */
  host: string;
  /** The host and the path: example.com/files/setup.exe. */
  path: string;
  /** The same with the query, where there is one: example.com/get.php?file=7. */
  full: string;
}

/** A link as a text has it. */
export interface Link {
  /** Whether it is written with http:// or https://. One that isn't (example.com/file) only may be a link. */
  schemed: boolean;
  /** Its scheme and host. One written without a scheme has both it could be read with, as they differ in the port they leave out. */
  origins: string[];
  /** What follows the host, up to the next space: the path and the query, and whatever the text has right after them. */
  tail: string;
}
