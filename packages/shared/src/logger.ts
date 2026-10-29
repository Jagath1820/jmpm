import pc from 'picocolors';

export const logger = {
  info(message: string, ...args: unknown[]) {
    console.log(pc.cyan('info'), message, ...args);
  },
  success(message: string, ...args: unknown[]) {
    console.log(pc.green('success'), message, ...args);
  },
  warn(message: string, ...args: unknown[]) {
    console.warn(pc.yellow('warn'), message, ...args);
  },
  error(message: string, ...args: unknown[]) {
    console.error(pc.red('error'), message, ...args);
  },
  step(step: string, message: string) {
    console.log(`${pc.magenta(`[${step}]`)} ${message}`);
  },
  dim(message: string) {
    console.log(pc.dim(message));
  }
};

