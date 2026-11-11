import { defineConfig } from '@vscode/test-cli';

// ponytail: point tests at local VSCodium instead of downloading MS VS Code.
// Set VSCODE_BIN if codium lives elsewhere.
const vscodeExecutablePath =
	process.env.VSCODE_BIN ?? 'C:\\Users\\Nafi\\AppData\\Local\\Programs\\VSCodium\\VSCodium.exe';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	useInstallation: { fromPath: vscodeExecutablePath },
});
