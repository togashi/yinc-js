#!/usr/bin/env node

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as readline from 'node:readline'
import * as stream from 'node:stream'
import { execSync } from 'node:child_process'
import { Command, InvalidArgumentError } from 'commander'
import { globIterate } from 'glob'
import * as yaml from 'yaml'

const VERSION = 'yinc.js version 0.3.1'

type Options = {
    indentWidth: number
    outputMultiDocuments: boolean
    includeTag: string
    replaceTag: string
}

class CDir {
    origin: string
    constructor(to: string) {
        this.origin = process.cwd()
        process.chdir(to)
    }
    return() {
        process.chdir(this.origin)
    }
}

class SourceStream {
    indent: string = ''
    firstIndent: string | null = null
    parent: SourceStream | null = null
    out: number = 0
    cdir: CDir | null = null

    constructor(public spec: string, public writer: stream.Writable) {
    }

    subStream(spec: string, indent: string, firstIndent: string | null = null): SourceStream {
        let p = this.parent
        while (p) {
            if (p.spec == spec) {
                throw new Error('cyclic include detected.')
            }
            p = p.parent
        }
        const sub = new SourceStream(spec, this.writer)
        sub.indent = indent
        sub.firstIndent = firstIndent
        sub.parent = this
        return sub
    }

    async getContent(): Promise<string[]> {
        if (this.spec === '' || this.spec === '-') {
            return new Promise<string[]>(resolve => {
                const lines: string[] = []
                const reader = readline.createInterface({
                    input: process.stdin,
                })
                reader.on('line', (line: string) => {
                    lines.push(line)
                })
                reader.on('close', () => {
                    resolve(lines)
                })
            })
        } else if (this.spec.startsWith('$(shell ') && this.spec.endsWith(')')) {
            const cmdline = this.spec.slice(8, -1)
            return execSync(cmdline).toString().split(/\r?\n/)
        } else if ((this.spec.startsWith('$(json ') && this.spec.endsWith(')')) || this.spec.endsWith('.json')) {
            const file = this.spec.startsWith('$(json ') ? this.spec.slice(7, -1) : this.spec
            const lines = await fs.readFile(file).then(data => {
                return yaml.stringify(JSON.parse(data.toString()), {
                    singleQuote: true
                }).split(/\r?\n/)
            })
            this.cdir = new CDir(path.dirname(file))
            return lines
        } else if (this.spec.startsWith('http://') || this.spec.startsWith('https://')) {
            return fetch(this.spec).then(res => {
                if (!res.ok) {
                    throw new Error(`HTTP error: ${res.status} ${res.statusText}`)
                }
                if (!res.body) return []
                return res.text().then(text => text.split(/\r?\n/))
            })
        } else {
            const lines = await fs.readFile(this.spec).then(data => {
                return data.toString().split(/\r?\n/)
            })
            this.cdir = new CDir(path.dirname(this.spec))
            return lines
        }
    }

    writeIndent(...chunks: string[]) {
        if (this.out === 0 && this.firstIndent) {
            this.write(this.firstIndent)
        } else {
            this.write(this.indent)
        }
        for (const chunk of chunks) {
            this.write(chunk)
        }
    }

    write(chunk: string) {
        this.writer.write(chunk)
        this.out += chunk.length
    }

    async *expandSpec(spec: string): AsyncGenerator<string> {
        if (spec.startsWith('$(shell ') && spec.endsWith(')')) {
            yield spec
        } else if (spec.startsWith('$(json ') && spec.endsWith(')')) {
            yield spec
        } else if (spec.startsWith('http://') || spec.startsWith('https://')) {
            yield spec
        } else {
            for await (const file of globIterate(spec)) {
                yield file
            }
        }
    }

    async process(options: Options): Promise<void> {
        const lines = await this.getContent()
        const escapedTag = `(${options.includeTag}|${options.replaceTag})`.replace(/!/g, '\\!')
        const exp = `^(?<indent>\\s*)((?<text>[^\\s#]+)\\s+)?(?<tag>${escapedTag})\\s+(?<spec>.+)$`
        const pat = new RegExp(exp)
        for (const line of lines) {
            if (!line) continue
            const m = pat.exec(line)
            if (m && m.groups) {
                let newIndent = this.indent + m.groups.indent
                for await (const file of this.expandSpec(m.groups.spec)) {
                    let firstIndent = ''
                    let indent = String(newIndent)
                    if (m.groups.text && m.groups.tag === options.includeTag) {
                        this.writeIndent(`${m.groups.indent}${m.groups.text}`)
                        if (m.groups.text !== '-') {
                            this.write('\n')
                        }
                        indent += ' '.repeat(options.indentWidth)
                        if (m.groups.text === '-') {
                            firstIndent = ' '
                        }
                    }
                    const sub = this.subStream(file, indent, firstIndent)
                    await sub.process(options)
                }
            } else {
                this.writeIndent(line + '\n')
            }
        }
        this.cdir?.return()
    }
}

async function start(files: string[], options: Options, /*cmd: Command*/) {
    if (files.length === 0) {
        files.push('-')
    }
    let nth = 0
    for (const file of files) {
        if (options.outputMultiDocuments && nth > 0) {
            process.stdout.write('---\n')
        }
        nth++
        const stream = new SourceStream(file, process.stdout)
        await stream.process(options)
    }
}

(() => {
    const cmd = new Command()
        .version(VERSION)
        .description('YAML include')
        .option('-w, --indent-width <n>', 'Indent width', (v: string): number => {
            const n = Number(v)
            if (isNaN(n) || Math.trunc(n) !== n) {
                throw new InvalidArgumentError('integer required.')
            }
            if (n < 1) {
                throw new InvalidArgumentError('must be 1 or greater than.')
            }
            return n
        }, 2)
        .option('-m, --output-multi-documents', 'Output multiple documents')
        .option('--include-tag <tag>', 'Specify include tag', '!include')
        .option('--replace-tag <tag>', 'Specify replace tag', '!replace')
        .arguments('[file...]')
        .action(start)
    cmd.parseAsync(process.argv)
})()
