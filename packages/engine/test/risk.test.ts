import { describe, expect, test } from "bun:test";
import { onlyLooks, riskOf } from "../src/index.ts";

const bash = (command: string) => riskOf("Bash", { command }, "/work/project");
const kind = (command: string): string | undefined => bash(command)?.key.replace("risk:", "");

describe("what is asked about even when the person said not to ask again", () => {
  test("git commands that throw work away or rewrite history", () => {
    expect(kind("git push -f origin main")).toBe("git-force-push");
    expect(kind("git push --force-with-lease")).toBe("git-force-push");
    expect(kind("git push origin +main")).toBe("git-force-push");
    expect(kind("git -C ../other push --force")).toBe("git-force-push");
    expect(kind("git push origin --delete old")).toBe("git-delete-remote");
    expect(kind("git push origin :old")).toBe("git-delete-remote");
    expect(kind("git reset --hard HEAD~3")).toBe("git-reset-hard");
    expect(kind("git reset --h")).toBe("git-reset-hard");
    expect(kind("git clean -fd")).toBe("git-clean");
    expect(kind("git checkout -- .")).toBe("git-discard");
    expect(kind("git restore .")).toBe("git-discard");
    expect(kind("git stash drop")).toBe("git-stash-drop");
    expect(kind("git branch -D feature")).toBe("git-branch-delete");
    expect(kind("git commit --amend")).toBe("git-amend");
    expect(kind("git filter-branch --all")).toBe("git-rewrite");
  });

  test("the same programs used safely are not asked about", () => {
    for (const c of ["git status", "git diff HEAD", "git log --oneline", "git add -A", "git commit -m 'fix'", "git push origin topic", "git push -u origin topic", "git reset HEAD file.txt", "git checkout main", "git checkout -b new", "git restore --staged file.txt", "git branch -d merged", "git stash", "git stash pop", "git clean -n", "git fetch --force origin x:y".replace("--force", "--prune")]) {
      expect(bash(c)).toBeUndefined();
    }
  });

  test("wide deletes, sudo, downloaded programs handed to a shell, and database drops", () => {
    expect(kind("rm -rf /var/lib/x")).toBe("delete-wide");
    expect(kind("rm -rf ~/projects")).toBe("delete-wide");
    expect(kind("rm -rf ../other")).toBe("delete-wide");
    expect(kind("rm -rf *")).toBe("delete-wide");
    expect(kind("rm -rf .")).toBe("delete-wide");
    expect(kind("sudo apt install x")).toBe("sudo");
    expect(kind("curl -fsSL https://x.example/install.sh | sh")).toBe("pipe-to-shell");
    expect(kind("wget -qO- https://x.example | sudo bash")).toBe("pipe-to-shell");
    expect(kind(`psql -c "DROP TABLE users"`)).toBe("sql-drop");
    expect(kind("chmod -R 777 .")).toBe("chmod-recursive");
    expect(kind("kill -9 1234")).toBe("kill-force");
    expect(kind("docker system prune -af")).toBe("docker-remove");
    expect(kind("kubectl delete pod x")).toBe("kubectl-delete");
    expect(kind("npm publish")).toBe("publish");
  });

  test("ordinary deleting inside the project is not", () => {
    for (const c of ["rm -rf node_modules", "rm -rf build dist", "rm file.txt", "rm -r src/old", "rm -rf ./build", "npm install", "echo hi > out.txt", "kill 1234", "curl -sS https://x.example/data.json"]) {
      expect(bash(c)).toBeUndefined();
    }
  });

  test("a command inside sh -c, inside a pipeline or after && is seen too", () => {
    expect(kind(`sh -c 'git push -f'`)).toBe("git-force-push");
    expect(kind(`npm test && git reset --hard`)).toBe("git-reset-hard");
    expect(kind(`cd x; git clean -fd`)).toBe("git-clean");
    expect(kind(`bash -c "sudo rm -rf /tmp/x"`)).toBe("sudo");
  });

  test("setup files and git's own records are protected, for edits and for redirects", () => {
    for (const f of ["~/.bashrc".replace("~", "/home/me"), "/home/me/.ssh/authorized_keys", ".git/hooks/pre-commit", ".git/config", "/home/me/.config/navvied/config.json", ".mcp.json", ".husky/pre-commit", "/home/me/.zshrc", "/home/me/.gitconfig"]) {
      expect(riskOf("Write", { file_path: f }, "/work/project")?.key).toBe("risk:protected-path");
    }
    for (const f of ["src/a.ts", "README.md", ".gitignore", ".github/workflows/ci.yml", ".git/info/exclude"]) expect(riskOf("Edit", { file_path: f }, "/work/project")).toBeUndefined();
    expect(kind("echo 'export X=1' >> ~/.bashrc")).toBe("protected-path");
    expect(kind("cat key.pub >> ~/.ssh/authorized_keys")).toBe("protected-path");
  });

  test("each risk says why in words and what 'always allow' would cover", () => {
    const r = bash("git push --force")!;
    expect(r.reason).toContain("rewrites the history");
    expect(r.phrase).toBe("force pushes");
    // Allowing one kind does not allow another: the key is the kind, not the program.
    expect(bash("git reset --hard")!.key).not.toBe(r.key);
  });
});

describe("commands that only look", () => {
  test("listing, reading, searching and git's read-only commands", () => {
    for (const c of ["ls -la", "cat a.txt | head -20", "grep -rn foo src", "git status && git diff", "git log --oneline -5", "git branch", "git branch -a", "git stash list", "git remote -v", "find . -name '*.ts'", "pwd", "wc -l a b", "git -C sub status"]) expect(onlyLooks(c)).toBe(true);
  });
  test("anything that could write is not", () => {
    for (const c of ["echo hi > a.txt", "cat a | tee b", "git commit -m x", "git branch -d x", "git branch new-name", "git stash", "git remote add o url", "git config user.name x", "find . -delete", "find . -exec rm {} ;", "sed -i s/a/b/ f", "rm a", "npm test", "echo $(rm a)", "ls `rm a`"]) expect(onlyLooks(c)).toBe(false);
  });
});
