import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'

const base = await generateEslintConfig({
	enableTypescript: true,
	ignores: ['build-test/**', 'pkg/**', '*.tgz'],
})

export default [
	...base,
	{
		// node:test's test() returns a promise that the runner awaits itself.
		files: ['test/**/*.ts'],
		rules: { '@typescript-eslint/no-floating-promises': 'off' },
	},
]
