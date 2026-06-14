// Julkaisee docs/-kansion gh-pages-haaraan force pushilla.
//
// Joka julkaisu korvaa gh-pages-haaran yhdellä commitilla -> päärepon (main)
// historia ei kasva built-sivun datasta. Aja keräyksen ja exportin jälkeen:
//
//   npm run scrape && npm run export && npm run deploy
//
import { execSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const DOCS = join(ROOT, "docs");

const sh = (cmd, opts = {}) => execSync(cmd, { stdio: "inherit", ...opts });
const shOut = (cmd, opts = {}) => execSync(cmd, { encoding: "utf8", ...opts }).trim();

if (!existsSync(DOCS)) {
  console.error("docs/ puuttuu — aja ensin: npm run export");
  process.exit(1);
}

let remote;
try {
  remote = shOut("git config --get remote.origin.url");
} catch {
  console.error("Ei origin-remotea. Luo repo ensin (esim. gh repo create).");
  process.exit(1);
}

// CI: GitHub Actionsissa ei ole tallennettuja git-tunnuksia, joten autentikoidaan
// push GITHUB_TOKENilla. Paikallisesti (ilman näitä ympäristömuuttujia) käytetään
// origin-remotea sellaisenaan, jolloin git-credential-helper hoitaa tunnukset.
const ghToken = process.env.GITHUB_TOKEN;
const ghRepo = process.env.GITHUB_REPOSITORY; // muotoa "owner/repo"
const pushUrl =
  ghToken && ghRepo ? `https://x-access-token:${ghToken}@github.com/${ghRepo}.git` : remote;

writeFileSync(join(DOCS, ".nojekyll"), "");

// Julkaise docs/ orpona gh-pages-haarana: oma kertakäyttöinen git-repo docs/:ssa,
// force push korvaa etähaaran kokonaan (yksi commit, ei historian kertymää).
rmSync(join(DOCS, ".git"), { recursive: true, force: true });
const git = (c) => sh(c, { cwd: DOCS });
git("git init -q");
git("git checkout -q -b gh-pages");
git("git add -A");
git('git -c user.name=deploy -c user.email=deploy@local commit -q -m "Deploy site"');
git(`git push -f ${JSON.stringify(pushUrl)} gh-pages`);
rmSync(join(DOCS, ".git"), { recursive: true, force: true });

console.log("\n✓ Julkaistu gh-pages-haaraan. GitHub Pages päivittyy hetken kuluttua.");
