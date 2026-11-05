import * as assert from "assert";
import {
  bodyExcerpt,
  deriveCheckState,
  itemLabelText,
  itemStatusText,
  relativeTime,
} from "../src/types";
import { GitHubItem } from "../src/types";

function item(overrides: Partial<GitHubItem> = {}): GitHubItem {
  return {
    kind: "issue",
    number: 1,
    title: "title",
    body: "",
    url: "",
    state: "OPEN",
    author: "me",
    updatedAt: "",
    ...overrides,
  };
}

describe("deriveCheckState", () => {
  it("treats missing rollup as unknown", () => {
    assert.strictEqual(deriveCheckState(undefined), "unknown");
    assert.strictEqual(deriveCheckState(null), "unknown");
    assert.strictEqual(deriveCheckState([]), "unknown");
  });

  it("reports failure when any check failed", () => {
    assert.strictEqual(
      deriveCheckState([{ state: "SUCCESS" }, { state: "FAILURE" }]),
      "failure"
    );
    assert.strictEqual(deriveCheckState([{ state: "ERROR" }]), "failure");
  });

  it("reports pending while checks are running", () => {
    assert.strictEqual(
      deriveCheckState([{ state: "SUCCESS" }, { state: "PENDING" }]),
      "pending"
    );
  });

  it("reports success only when every check succeeded", () => {
    assert.strictEqual(deriveCheckState([{ state: "SUCCESS" }]), "success");
  });

  it("handles GitHub Actions CheckRun entries", () => {
    assert.strictEqual(
      deriveCheckState([{ status: "in_progress", conclusion: null }]),
      "pending"
    );
    assert.strictEqual(
      deriveCheckState([{ status: "completed", conclusion: "failure" }]),
      "failure"
    );
    assert.strictEqual(
      deriveCheckState([{ status: "completed", conclusion: "success" }]),
      "success"
    );
    assert.strictEqual(
      deriveCheckState([{ status: "completed", conclusion: "neutral" }]),
      "success"
    );
    assert.strictEqual(
      deriveCheckState([{ status: "completed", conclusion: "timed_out" }]),
      "failure"
    );
  });

  it("mixes StatusContext and CheckRun entries", () => {
    assert.strictEqual(
      deriveCheckState([
        { state: "SUCCESS" },
        { status: "completed", conclusion: "failure" },
      ]),
      "failure"
    );
    assert.strictEqual(
      deriveCheckState([
        { state: "SUCCESS" },
        { status: "queued", conclusion: null },
      ]),
      "pending"
    );
  });
});

describe("itemStatusText", () => {
  it("is empty for plain issues", () => {
    assert.strictEqual(itemStatusText(item()), "");
  });

  it("combines draft and check state for PRs", () => {
    assert.strictEqual(
      itemStatusText(
        item({ kind: "pr", isDraft: true, checkState: "failure" })
      ),
      "draft · checks failing"
    );
  });

  it("includes review decisions", () => {
    assert.strictEqual(
      itemStatusText(
        item({ kind: "pr", checkState: "success", reviewDecision: "CHANGES_REQUESTED" })
      ),
      "checks passing · changes requested"
    );
  });
});

describe("itemLabelText", () => {
  it("joins up to three labels", () => {
    const labels = ["bug", "p1", "ui", "extra"];
    assert.strictEqual(itemLabelText(item({ labels })), "bug, p1, ui");
  });

  it("is empty without labels", () => {
    assert.strictEqual(itemLabelText(item()), "");
  });
});

describe("relativeTime", () => {
  it("returns empty for invalid dates", () => {
    assert.strictEqual(relativeTime("not-a-date"), "");
  });

  it("describes recent activity", () => {
    const now = Date.now();
    assert.strictEqual(relativeTime(new Date(now - 5_000).toISOString(), now), "just now");
    assert.strictEqual(relativeTime(new Date(now - 3 * 60_000).toISOString(), now), "3m ago");
    assert.strictEqual(relativeTime(new Date(now - 5 * 3_600_000).toISOString(), now), "5h ago");
    assert.strictEqual(relativeTime(new Date(now - 3 * 86_400_000).toISOString(), now), "3d ago");
  });
});

describe("bodyExcerpt", () => {
  it("returns short bodies unchanged", () => {
    assert.strictEqual(bodyExcerpt("hello"), "hello");
  });

  it("truncates long bodies with an ellipsis", () => {
    const long = "x".repeat(300);
    const excerpt = bodyExcerpt(long, 200);
    assert.strictEqual(excerpt.length, 201);
    assert.ok(excerpt.endsWith("…"));
  });
});
