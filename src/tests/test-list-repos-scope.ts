import { strict as assert } from "node:assert";
import {
  isProjectDiscoveryTool,
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

const unscopedCalls: unknown[] = [];
const unscopedTool = wrapGitNexusListReposTool({
  name: "gitnexus_list_repos",
  description: "List indexed repositories",
  invoke: async (args: unknown) => {
    unscopedCalls.push(args);
    return JSON.stringify({ repositories: [{ name: "oa-stock" }] });
  },
}, "gitnexus", {});
await unscopedTool.invoke({});
assert.equal(unscopedCalls.length, 1, "未知项目范围省略 scope 时必须发现全部已索引项目");

assert.equal(
  isProjectDiscoveryTool(wrappedTool),
  true,
  "包装后的 GitNexus list_repos 必须标记为项目发现工具",
);
assert.equal(
  isProjectDiscoveryTool(nonTargetTool),
  false,
  "非 list_repos 工具不得被标记为项目发现工具",
);

// 项目范围已知时，模型必须仍能查到自己的可查项目，否则只能猜测仓库名。
const knownScopeResult = JSON.parse(String(await wrappedTool.invoke({ scope: "queryable" })));
assert.deepEqual(
  knownScopeResult.projects,
  ["oa-stock", "oa-order"],
  "项目范围已知时 list_repos 仍须返回可查项目，不得被注册阶段摘除",
);

console.log("list_repos scope 参数验证通过");
