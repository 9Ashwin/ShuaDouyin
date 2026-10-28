import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { CliError } from "../errors.ts";

// O_NOFOLLOW is the atomic way to refuse a symlink, but Windows has no such
// flag and `?? 0` would have silently turned the protection off there. Check
// with lstat first so every platform refuses a link; the flag still closes the
// race between that check and the open where the platform offers it.
async function refuseSymlink(path: string): Promise<void> {
	try {
		if ((await lstat(path)).isSymbolicLink())
			throw new CliError("invalid_argument", "Image path must not be a symbolic link");
	} catch (cause) {
		if (cause instanceof CliError) throw cause;
		// A missing path is reported by the open below with the same shape.
	}
}

export async function readImage(path: string) {
	await refuseSymlink(path);
	let file: Awaited<ReturnType<typeof open>>;
	try {
		file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	} catch (cause) {
		throw new CliError("invalid_argument", "Image file cannot be opened", { cause });
	}
	try {
		const info = await file.stat();
		if (!info.isFile() || info.size < 8 || info.size > 10_000_000)
			throw new CliError("invalid_argument", "Image must be a regular file between 8 bytes and 10 MB");
		const buffer = Buffer.alloc(info.size + 1);
		let length = 0;
		while (length < buffer.length) {
			const read = await file.read(buffer, length, buffer.length - length, length);
			if (!read.bytesRead) break;
			length += read.bytesRead;
		}
		if (length !== info.size) throw new CliError("revision_conflict", "Image changed while reading");
		const after = await file.stat();
		if (
			after.size !== info.size ||
			after.mtimeMs !== info.mtimeMs ||
			after.ctimeMs !== info.ctimeMs ||
			after.ino !== info.ino
		)
			throw new CliError("revision_conflict", "Image changed while reading");
		const bytes = buffer.subarray(0, length);
		const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
			? "image/png"
			: bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
				? "image/jpeg"
				: bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a"
					? "image/gif"
					: null;
		if (!mime) throw new CliError("invalid_argument", "Image must be PNG, JPEG or GIF");
		const extension = mime === "image/png" ? ".png" : mime === "image/jpeg" ? ".jpg" : ".gif";
		return { bytes, mime, name: `image${extension}`, sha256: createHash("sha256").update(bytes).digest("hex") };
	} finally {
		await file.close();
	}
}
