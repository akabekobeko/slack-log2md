import fs from 'fs'
import path from 'path'
import util from 'util'
import parseChannel, { Channel } from './channel'
import parseUser, { User } from './user'
import parseMessage, { Message } from './message'
import messagesToMarkdown from './markdown'
import Logger from './logger'
import { tsToDate, formatDate } from './metadata'

const readFileAsync = util.promisify(fs.readFile)
const readdirAsync = util.promisify(fs.readdir)
const writeFileASync = util.promisify(fs.writeFile)
const statAsync = util.promisify(fs.stat)
const mkdirAsync = util.promisify(fs.mkdir)

/** Message types to ignore. */
export type IgnoreMessage = {
  /** `true` to ignore the channel login message. */
  channelLogin?: boolean
}

/** Options of slack-log2md. */
export type Log2MdOptions = {
  /** `true` to display the processing status of the tool to `stdout`. */
  report?: boolean

  /**
   * `true` if messages in the channel are grouped by the same day in UTC.
   * If `false`, the group is the output log file unit.
   */
  groupingSameDayByUTC?: boolean

  /** Specifies the type of message to ignore. */
  ignore?: IgnoreMessage
}

/**
 * Enumerate the directory that becomes the channel.
 * @param rootDir Path of the workspace root directory.
 * @returns Collection of the directory paths.
 */
const enumChannelDirs = async (rootDir: string): Promise<string[]> => {
  const items = await readdirAsync(rootDir)
  const results: string[] = []

  for (const item of items) {
    const dir = path.join(rootDir, item)
    const stat = await statAsync(dir)
    if (stat.isDirectory()) {
      results.push(dir)
    }
  }

  return results
}

/**
 * Enumerates the path of the JSON file that is the channel log.
 * @param dir Path of the channel directory.
 * @returns Collection of the JSON file paths.
 */
const enumMessageJSONs = async (dir: string): Promise<string[]> => {
  const items = await readdirAsync(dir)
  const results: string[] = []

  for (const item of items) {
    if (!item.endsWith('.json')) {
      continue
    }

    const filePath = path.join(dir, item)
    const stat = await statAsync(filePath)
    if (stat.isDirectory()) {
      continue
    }

    results.push(filePath)
  }

  return results
}

/**
 * Read array from JSON file.
 * @param filePath Path of JSON file.
 * @returns Array.
 */
const readArrayFromJSON = async (filePath: string): Promise<any[]> => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File does not exist. "${filePath}"`)
  }

  const values = JSON.parse(await readFileAsync(filePath, 'utf8'))
  if (!Array.isArray(values)) {
    throw new Error('Data is not an array.')
  }

  return values
}

/**
 * Read channel informations from JSON file.
 * @param dir Path of JSON directory.
 * @returns Dictionary (id/channel) of the channels.
 */
export const readChannels = async (
  dir: string
): Promise<Map<string, Channel>> => {
  const values = await readArrayFromJSON(path.join(dir, 'channels.json'))
  const channels = new Map<string, Channel>()

  for (const value of values) {
    const channel = parseChannel(value)
    channels.set(channel.id, channel)
  }

  return channels
}

/**
 * Read user informations from JSON file.
 * @param dir Path of JSON directory.
 * @returns Dictionary (id/user) of the users.
 */
export const readUsers = async (dir: string): Promise<Map<string, User>> => {
  const values = await readArrayFromJSON(path.join(dir, 'users.json'))
  const users = new Map<string, User>()

  for (const value of values) {
    const user = parseUser(value)
    users.set(user.id, user)
  }

  return users
}

/**
 * Read messages from JSON file.
 * @param dir Path of JSON file.
 * @returns Messages.
 */
export const readMessages = async (filePath: string): Promise<Message[]> => {
  const values = await readArrayFromJSON(filePath)
  const messages: Message[] = []
  for (const value of values) {
    messages.push(await parseMessage(value))
  }

  return messages
}

/**
 * Check if the message should be ignored.
 * @param message Message.
 * @param ignore Message types of ignore.
 * @returns `true` if it should be ignored.
 */
const isIgnore = (message: Message, ignore: IgnoreMessage): boolean => {
  if (ignore.channelLogin) {
    return message.subtype === 'channel_join'
  }

  return false
}

/**
 * Convert messages in the channel to Markdown by same day (UTC).
 * @param src Path of the channel directory.
 * @param dest Path of the output directory.
 * @param channels Dictionary (id/cnannel) of the channels.
 * @param users Dictionary (id/user) of the users.
 * @param ignore Message types to ignore.
 */
const convertChannelMessagesSameDay = async (
  src: string,
  dest: string,
  channels: Map<string, Channel>,
  users: Map<string, User>,
  ignore: IgnoreMessage
) => {
  // Create a sub directory for each channel
  if (!fs.existsSync(dest)) {
    await mkdirAsync(dest)
  }

  // Group messages in a channel on the same day (UTC).
  const filePaths = await enumMessageJSONs(src)
  const logs = new Map<string, Message[]>()
  for (const filePath of filePaths) {
    const messages = await readMessages(filePath)
    for (const message of messages) {
      if (isIgnore(message, ignore)) {
        continue
      }

      const date = formatDate(tsToDate(message.timeStamp), 'YYYY-MM-DD', true)
      const targets = logs.get(date)
      if (targets) {
        targets.push(message)
      } else {
        logs.set(date, [message])
      }
    }
  }

  // Output markdown
  let logNames: string[] = []
  for (const logName of logs.keys()) {
    const messages = logs.get(logName)!
    const table = messagesToMarkdown(messages, channels, users)
    const markdown = `# ${logName}\n\n${table}`
    const destFilePath = path.join(dest, `${logName}.md`)
    await writeFileASync(destFilePath, markdown)

    logNames.push(logName)
  }

  // Output index (Descending of date)
  let indexMd = ''
  logNames = logNames.sort((a, b) => (a === b ? 0 : a < b ? 1 : -1))
  for (const logName of logNames) {
    indexMd += `- [${logName}](./${logName}.md)\n`
  }

  if (indexMd !== '') {
    const destFilePath = path.join(dest, 'index.md')
    await writeFileASync(destFilePath, `# ${path.basename(src)}\n\n${indexMd}`)
  }
}

/**
 * Convert messages in the channel to Markdown.
 * @param src Path of the channel directory.
 * @param dest Path of the output directory.
 * @param channels Dictionary (id/cnannel) of the channels.
 * @param users Dictionary (id/user) of the users.
 * @param ignore Message types to ignore.
 */
const convertChannelMessages = async (
  src: string,
  dest: string,
  channels: Map<string, Channel>,
  users: Map<string, User>,
  ignore: IgnoreMessage
) => {
  // Create a sub directory for each channel
  if (!fs.existsSync(dest)) {
    await mkdirAsync(dest)
  }

  // Sort in descending order for index page, log conversion does not depend on the order
  const filePaths = (await enumMessageJSONs(src)).sort((a, b) =>
    a === b ? 0 : a < b ? 1 : -1
  )

  let indexMd = ''
  for (const filePath of filePaths) {
    const messages = (await readMessages(filePath)).filter(
      (message) => !isIgnore(message, ignore)
    )
    if (messages.length === 0) {
      continue
    }

    const table = messagesToMarkdown(messages, channels, users)
    const logName = path.basename(filePath, '.json')
    const markdown = `# ${logName}\n\n${table}`
    const destFilePath = path.join(dest, `${logName}.md`)
    await writeFileASync(destFilePath, markdown)

    indexMd += `- [${logName}](./${logName}.md)\n`
  }

  // Index page
  if (indexMd !== '') {
    const destFilePath = path.join(dest, 'index.md')
    await writeFileASync(destFilePath, `# ${path.basename(src)}\n\n${indexMd}`)
  }
}

/**
 * Check the ignore option.
 * @param ignore Message types of ignore.
 * @returns Checked option.
 */
const checkIgnoreOption = (ignore?: IgnoreMessage): IgnoreMessage => {
  if (ignore) {
    return {
      channelLogin: !!ignore.channelLogin
    }
  }

  return {
    channelLogin: false
  }
}

/**
 * Converts Slack log JSON in the specified workspace directory to Markdown.
 * @param inputDir Directory path of the JSON file exported from Slack.
 * @param outputDir Directory path to output Markdown file converted from JSON.
 * @param options Options.
 */
const log2Md = async (
  inputDir: string,
  outputDir: string,
  options: Log2MdOptions
): Promise<void> => {
  const logger = new Logger(!!options.report)
  logger.log(`src: "${inputDir}"`)
  logger.log(`dest: "${outputDir}"`)
  logger.log('Converted channels...')

  const channels = await readChannels(inputDir)
  const users = await readUsers(inputDir)
  const channelDirs = await enumChannelDirs(inputDir)
  const ignore = checkIgnoreOption(options.ignore)

  for (const src of channelDirs) {
    const channel = path.basename(src)
    logger.log(`  #${channel}`)
    const dest = path.join(outputDir, channel)
    if (!!options.groupingSameDayByUTC) {
      await convertChannelMessagesSameDay(src, dest, channels, users, ignore)
    } else {
      await convertChannelMessages(src, dest, channels, users, ignore)
    }
  }

  logger.log('Completed!!')
}

export default log2Md
