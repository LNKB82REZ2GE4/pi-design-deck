import { spawn } from "node:child_process";

const TIMEOUT_MS = 120_000;

export async function generateWithModel(fullModel: string, task: string): Promise<string> {
	const parts = fullModel.split("/");
	if (parts.length < 2) {
		throw new Error(`Invalid model format: ${fullModel}. Expected "provider/model-id"`);
	}
	const provider = parts[0];
	const modelId = parts.slice(1).join("/");

	return new Promise((resolve, reject) => {
		const args = ["--provider", provider, "--model", modelId, "--no-tools", "--no-session", "-p", task];

		const proc = spawn("pi", args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		proc.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		const timer = setTimeout(() => {
			proc.kill("SIGTERM");
			reject(new Error("Generation timed out after 2 minutes"));
		}, TIMEOUT_MS);

		proc.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});

		proc.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) {
				resolve(stdout.trim());
			} else {
				reject(new Error(`pi exited with code ${code}: ${stderr.slice(0, 500)}`));
			}
		});
	});
}
