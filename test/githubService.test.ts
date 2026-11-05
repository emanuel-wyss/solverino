import * as assert from "assert";
import {
  buildErrorIssueBody,
  buildErrorIssueTitle,
  classifyPullRequests,
} from "../src/services/githubService";
import { ChatSession } from "../src/types";

function session(patch: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "issue-42",
    kind: "issue",
    number: 42,
    title: "Fix login",
    status: "error",
    history: [],
    ...patch,
  };
}

describe("buildErrorIssueTitle", () => {
  it("includes kind, number, and error message", () => {
    const title = buildErrorIssueTitle(
      session({ errorMessage: "Agent exited with code 1." })
    );
    assert.ok(title.includes("#42"));
    assert.ok(title.includes("Agent exited with code 1."));
  });

  it("truncates long error messages", () => {
    const title = buildErrorIssueTitle({
      ...session(),
      kind: "pr",
      number: 7,
      errorMessage: "x".repeat(200),
    });
    assert.ok(title.length < 120);
    assert.ok(title.endsWith("…"));
  });
});

describe("buildErrorIssueBody", () => {
  it("includes the error message and context", () => {
    const body = buildErrorIssueBody(
      session({
        errorMessage: "boom",
        branch: "issue-42",
        worktreePath: "/tmp/solverino-repo-issue-42",
      })
    );
    assert.ok(body.includes("boom"));
    assert.ok(body.includes("#42"));
    assert.ok(body.includes("`issue-42`"));
    assert.ok(body.includes("/tmp/solverino-repo-issue-42"));
  });

  it("includes the tail of the last agent message", () => {
    const body = buildErrorIssueBody(
      session({
        errorMessage: "boom",
        history: [
          {
            role: "agent",
            text: "line1\nline2\nline3",
            timestamp: 1,
          },
        ],
      })
    );
    assert.ok(body.includes("line3"));
  });

  it("notes when no agent output was captured", () => {
    const body = buildErrorIssueBody(session({ errorMessage: "boom" }));
    assert.ok(body.includes("(no agent output captured)"));
  });
});

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
