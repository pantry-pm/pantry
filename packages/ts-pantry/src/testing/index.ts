import { startMysql, stopMysql, useMysql, withMysql } from './mysql'
import { startPostgres, stopPostgres, usePostgres, withPostgres } from './postgres'
import { startRedis, stopRedis, useRedis, withRedis } from './redis'
import { PantryService } from './service'
import { createTempDir, createTestDir, createTestFile, removeTempDir, withTempDir, withTempDirSync } from './temp'

export type { MysqlConfig, MysqlConnection } from './mysql'
export type { PostgresConfig, PostgresConnection } from './postgres'
export type { RedisConfig, RedisConnection } from './redis'
export type { TestServiceConfig, TestServiceStatus } from './service'

export interface TestingRuntime {
  createTempDir: typeof createTempDir
  createTestDir: typeof createTestDir
  createTestFile: typeof createTestFile
  PantryService: typeof PantryService
  removeTempDir: typeof removeTempDir
  startMysql: typeof startMysql
  startPostgres: typeof startPostgres
  startRedis: typeof startRedis
  stopMysql: typeof stopMysql
  stopPostgres: typeof stopPostgres
  stopRedis: typeof stopRedis
  useMysql: typeof useMysql
  usePostgres: typeof usePostgres
  useRedis: typeof useRedis
  withMysql: typeof withMysql
  withPostgres: typeof withPostgres
  withRedis: typeof withRedis
  withTempDir: typeof withTempDir
  withTempDirSync: typeof withTempDirSync
}

// This aggregate is also useful for dynamically selected test infrastructure.
// Keeping the concrete implementations in an exported value prevents Bun from
// dropping them while retaining only the named export aliases for this facade.
export const testingRuntime: TestingRuntime = {
  createTempDir,
  createTestDir,
  createTestFile,
  PantryService,
  removeTempDir,
  startMysql,
  startPostgres,
  startRedis,
  stopMysql,
  stopPostgres,
  stopRedis,
  useMysql,
  usePostgres,
  useRedis,
  withMysql,
  withPostgres,
  withRedis,
  withTempDir,
  withTempDirSync,
}

export {
  createTempDir,
  createTestDir,
  createTestFile,
  PantryService,
  removeTempDir,
  startMysql,
  startPostgres,
  startRedis,
  stopMysql,
  stopPostgres,
  stopRedis,
  useMysql,
  usePostgres,
  useRedis,
  withMysql,
  withPostgres,
  withRedis,
  withTempDir,
  withTempDirSync,
}
