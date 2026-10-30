// Never gets as far as initializing MoeLog: it blows up first, like a missing config.
throw new Error('DATABASE_URL is missing')
