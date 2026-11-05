import * as assert from "assert";
import {
  buildErrorIssueBody,
  buildErrorIssueTitle,
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
