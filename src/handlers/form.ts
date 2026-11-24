import { readFile } from "node:fs/promises";
import type { ProjectConfig } from "../config.ts";

let uploadHtmlPromise: Promise<string> | null = null;

function loadUploadHtml(): Promise<string> {
	if (!uploadHtmlPromise) {
		// `src/upload.html` in a checkout, `dist/upload.html` in the built package
		// (the build copies it beside the emitted JS).
		uploadHtmlPromise = readFile(new URL("../upload.html", import.meta.url), "utf8");
	}
	return uploadHtmlPromise;
}

/**
 * Handle GET /:projectId — serve the HTML upload form.
 * Returns null if the upload form is disabled for this project.
 */
export async function handleForm(
	_req: Request,
	projectId: string,
	config: ProjectConfig,
	version: string,
	defaultEnableForm: boolean,
): Promise<Response | null> {
	const enabled = config.enableUploadForm ?? defaultEnableForm;
	if (!enabled) return null;

	const template = await loadUploadHtml();
	const html = template
		.replaceAll("{{PROJECT_ID}}", projectId)
		.replaceAll("{{VERSION}}", version);

	return new Response(html, {
		headers: { "content-type": "text/html; charset=utf-8" },
	});
}
