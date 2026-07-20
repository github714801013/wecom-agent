import { strict as assert } from "node:assert";
import {
  parseQueryableProjects,
  wrapGitNexusListReposTool,
} from "../mcp-client.js";

assert.deepEqual(
  parseQueryableProjects({ projects: "oa-stock, oa-order,,oa-stock,neo-oa " }),
  ["oa-stock", "oa-order", "neo-oa"],
  "projects header should be trimmed, de-duplicated, and keep first-seen order",
);
assert.deepEqual(
  parseQueryableProjects({ Projects: "oa-stock" }),
  ["oa-stock"],
  "projects header lookup should be case-insensitive",
);
assert.deepEqual(parseQueryableProjects({}), [], "missing projects header should produce an empty queryable list");

let originalCalls = 0;
const originalTool = {
  name: "gitnexus_list_repos",
  description: "List indexed repositories",
  invoke: async (args: unknown) => {
    originalCalls += 1;
    return JSON.stringify({ args, projects: ["oa-stock", "hidden-index"] });
  },
};
const wrappedTool = wrapGitNexusListReposTool(originalTool, "gitnexus", {
  projects: "oa-stock,oa-order,oa-stock",
});

assert.notEqual(wrappedTool, originalTool, "GitNexus list_repos should be wrapped");
assert.equal(wrappedTool.name, originalTool.name, "wrapped tool must keep the original MCP tool name");
assert.match(wrappedTool.description, /queryable/);
assert.match(wrappedTool.description, /all_indexed/);

const defaultResult = JSON.parse(String(await wrappedTool.invoke({})));
assert.equal(defaultResult.scope, "queryable", "scope should default to queryable");
assert.deepEqual(defaultResult.projects, ["oa-stock", "oa-order"]);
assert.equal(defaultResult.count, 2);
assert.equal(originalCalls, 0, "queryable scope must not call the remote list_repos tool");

const explicitQueryableResult = JSON.parse(String(await wrappedTool.invoke({ scope: "queryable" })));
assert.deepEqual(explicitQueryableResult.projects, ["oa-stock", "oa-order"]);
assert.equal(originalCalls, 0, "explicit queryable scope must remain local");

const allIndexedResult = await wrappedTool.invoke({ scope: "all_indexed" });
assert.match(String(allIndexedResult), /hidden-index/);
assert.equal(originalCalls, 1, "all_indexed scope should call the original tool exactly once");

const nonTargetTool = {
  name: "gitnexus_query",
  description: "Query code",
  invoke: async () => "ok",
};
assert.equal(
  wrapGitNexusListReposTool(nonTargetTool, "gitnexus", { projects: "oa-stock" }),
  nonTargetTool,
  "non-list_repos GitNexus tools should not be wrapped",
);
assert.equal(
  wrapGitNexusListReposTool(originalTool, "other-mcp", { projects: "oa-stock" }),
  originalTool,
  "list_repos tools from non-GitNexus servers should not be wrapped",
);

console.log("list_repos scope 参数验证通过");
