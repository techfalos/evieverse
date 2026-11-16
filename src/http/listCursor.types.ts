/** Which page of a list a request asks for: its size, and the last row of the page before it. */
export interface ListPage {
  limit: number;
  after?: { createdAt: number; userId: string };
}
