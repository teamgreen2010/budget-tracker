import { databaseConfig } from './connection';

const databaseConfigs = {
  [process.env.NODE_ENV || 'development']: { ...databaseConfig({ validate: true }), logging: false },
};
export = databaseConfigs;
