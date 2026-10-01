import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'

const base = await generateEslintConfig({ ignores: ['pkg/**', 'dist/**', '*.tgz'] })

export default [
	...base,
	{
		// This package is ESM ("type": "module").
		files: ['**/*.js'],
		languageOptions: { sourceType: 'module' },
	},
]
