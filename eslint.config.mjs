import config from '@iobroker/eslint-config';

export default [
    ...config,
    {
        languageOptions: {
            parserOptions: {
                allowDefaultProject: {
                    allow: ['*.js', '*.mjs'],
                },
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    {
        // `controller.js` and `iobroker-data` are created by the "iobroker.js-controller" dev dependency
        ignores: [
            'build/*',
            'test/*',
            'test/lib/*',
            'controller.js',
            'iobroker-data/*',
            'eslint.config.mjs',
            'prettier.config.mjs',
            'tasks.mts',
            'node_modules/*'
        ],
    },
    {
        // disable temporary the rule 'jsdoc/require-param' and enable 'jsdoc/require-jsdoc'
        rules: {
            'jsdoc/require-jsdoc': 'off',
            'jsdoc/require-param': 'off',
        },
    },
];
