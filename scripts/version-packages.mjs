import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = path.join(rootDir, "packages");
const rootPackagePath = path.join(rootDir, "package.json");

const readPackageJson = async (packagePath) => {
  return JSON.parse(await readFile(packagePath, "utf8"));
};

const writePackageJson = async (packagePath, packageJson) => {
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
};

const rootPackageJson = await readPackageJson(rootPackagePath);
const version = rootPackageJson.version;

if (typeof version !== "string" || version.length === 0) {
  throw new Error("Root package.json must define a version.");
}

const packageDirs = await readdir(packagesDir, { withFileTypes: true });
const packagePaths = packageDirs
  .filter((dirent) => dirent.isDirectory())
  .map((dirent) => path.join(packagesDir, dirent.name, "package.json"));

const workspacePackageNames = new Set();
const packageJsonByPath = new Map();

for (const packagePath of packagePaths) {
  const packageJson = await readPackageJson(packagePath);
  packageJsonByPath.set(packagePath, packageJson);

  if (typeof packageJson.name === "string") {
    workspacePackageNames.add(packageJson.name);
  }
}

for (const [packagePath, packageJson] of packageJsonByPath) {
  packageJson.version = version;

  for (const dependencyName of Object.keys(packageJson.peerDependencies ?? {})) {
    if (workspacePackageNames.has(dependencyName)) {
      packageJson.peerDependencies[dependencyName] = `^${version}`;
    }
  }

  await writePackageJson(packagePath, packageJson);
}
