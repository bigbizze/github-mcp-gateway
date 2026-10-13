# Future bounded patch reconstruction

The connector returns only the patch text that GitHub provides for one exact changed path. GitHub can omit this text. The connector marks each returned patch as `source: "github"` and `completeness: "unverified"`.

The connector does not invent missing patches. An omitted patch can represent a binary file, symbolic link, submodule, large change, mode-only change, rename, or another unsupported case.

## Possible later design

A later version could reconstruct one bounded patch from pinned Git objects. The operation would require the exact path from a changed-filename operation. It would also require pinned base and target descriptors.

The reconstruction flow could use these steps:

1. Resolve the base and target repository identities and commit SHAs.
2. Resolve the exact tree entries for the old and new paths.
3. Classify regular files, links, submodules, and missing entries.
4. Read bounded blob windows through range-capable sources.
5. Produce bounded hunks for the requested path.
6. Apply the patch to the pinned base bytes.
7. Compare the applied result with the pinned target bytes.

The operation must not claim completeness unless apply-based verification succeeds.

## Renames and forks

A rename needs both the previous path and target path. The operation must keep rename detection separate from content reconstruction. It must not infer a rename only from similar content.

A pull request can use a head repository that differs from the base repository. The connector must authorize and pin each repository separately. It must return a safe error when the installation cannot read one side.

## File modes and special entries

Git trees contain file modes that distinguish regular files, executable files, symbolic links, trees, and submodules. A later result must report old and new modes. It must represent mode-only changes without a synthetic text patch.

Symbolic links need link-target text handling. Submodules need pinned object IDs and no invented file content. Binary files need metadata only unless a separate bounded binary design exists.

## Resource and Free-plan tests

Patch reconstruction can consume CPU and memory even when output is small. A release gate must measure worst-case files, long lines, large rename candidates, and many hunks through `workerd` and a staging Worker.

The Free-plan tests must measure at least 100 requests for each selected scan size. The p99 CPU target must remain at or below 8 ms. Tests must also verify the 128 MB memory limit, the 20-subrequest connector cap, and the six-connection cap.

If the smallest safe scan size cannot meet these limits, patch reconstruction must stay out of the Free-plan build.
