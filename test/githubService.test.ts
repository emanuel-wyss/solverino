import * as assert from "assert";
import { classifyPullRequests, codespaceNewUrl } from "../src/services/githubService";

describe("classifyPullRequests", () => {
  const me = "me";
  const other = { author: "someone-else", kind: "pr" as const, number: 1, title: "", body: "", url: "", state: "OPEN", updatedAt: "" };

  it("keeps PRs authored by me", () => {
    const sections = classifyPullRequests([{ ...other, number: 1, author: me }], me);
    assert.deepStrictEqual(sections.mine.map((p) => p.number), [1]);
    assert.deepStrictEqual(sections.reviewRequested, []);
  });

  it("keeps PRs in which I am an assignee", () => {
    const sections = classifyPullRequests([{ ...other, number: 2, assignees: [me] }], me);
    assert.deepStrictEqual(sections.mine.map((p) => p.number), [2]);
  });

  it("puts PRs where I am a requested reviewer in the review section", () => {
    const sections = classifyPullRequests([{ ...other, number: 3, reviewRequests: [me] }], me);
    assert.deepStrictEqual(sections.mine, []);
    assert.deepStrictEqual(sections.reviewRequested.map((p) => p.number), [3]);
  });

  it("keeps own PRs out of the review section even when review is requested", () => {
    const sections = classifyPullRequests(
      [{ ...other, number: 4, author: me, reviewRequests: [me] }],
      me
    );
    assert.deepStrictEqual(sections.mine.map((p) => p.number), [4]);
    assert.deepStrictEqual(sections.reviewRequested, []);
  });

  it("falls back to showing all PRs when the current user is unknown", () => {
    const sections = classifyPullRequests([{ ...other, number: 5 }], undefined);
    assert.deepStrictEqual(sections.mine.map((p) => p.number), [5]);
    assert.deepStrictEqual(sections.reviewRequested, []);
  });
});

describe("codespaceNewUrl", () => {
  it("builds the codespace creation URL for a repo and branch", () => {
    assert.strictEqual(
      codespaceNewUrl("owner/repo", "issue-42"),
      "https://codespaces.new/owner/repo/tree/issue-42"
    );
  });

  it("encodes refs with slashes", () => {
    assert.strictEqual(
      codespaceNewUrl("owner/repo", "feature/branch"),
      "https://codespaces.new/owner/repo/tree/feature/branch"
    );
  });
});
