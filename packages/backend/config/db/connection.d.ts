export function loadEnvironment(): void;
export function databaseConfig(options?: { workerId?: string; validate?: boolean }): {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  dialect: 'postgres';
};
export function databasePool(): { max: number; min: number; idle: number; evict: number; acquire: number };
