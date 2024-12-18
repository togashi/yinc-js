import esbuild from 'esbuild'

esbuild.build({
    bundle: true,
    minify: true,
    entryPoints: ['src/index.ts'],
    outfile: 'dist/yinc.js',
    platform: 'node',
    format: 'cjs',
})
