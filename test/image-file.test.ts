import assert from "node:assert/strict";
import { access, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { App } from "../src/app.ts";
import { readImage } from "../src/operations/image-file.ts";

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aU0AAAAASUVORK5CYII=",
	"base64",
);

test("image file validation and dry-run do not start Chrome or create state", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "dy-image-file-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "generated.png");
	await writeFile(path, png);
	const image = await readImage(path);
	assert.equal(image.mime, "image/png");
	assert.equal(image.bytes.length, png.length);
	assert.match(image.sha256, /^[a-f0-9]{64}$/);
	const state = join(dir, "state");
	const result = (await new App({ state_dir: state }).execute("chat.image", {
		conversation_id: "native:123",
		image: path,
		dry_run: true,
	})) as { executed: boolean; media: { mime: string } };
	assert.equal(result.executed, false);
	assert.equal(result.media.mime, "image/png");
	await assert.rejects(access(state));
	const link = join(dir, "alias.png");
	await symlink(path, link);
	await assert.rejects(readImage(link), { code: "invalid_argument" });
	await writeFile(join(dir, "bad.png"), "not an image");
	await assert.rejects(readImage(join(dir, "bad.png")), { code: "invalid_argument" });
	const gif = join(dir, "test.gif");
	await writeFile(gif, Buffer.from("GIF89a00"));
	await assert.rejects(
		new App({ state_dir: state }).execute("comment.image", { video_id: "12345", image: gif, dry_run: true }),
		{ code: "invalid_argument" },
	);
});
