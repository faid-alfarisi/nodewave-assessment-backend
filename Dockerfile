FROM oven/bun:1.2-alpine

WORKDIR /app

# Install OpenSSL (required by Prisma on Alpine Linux)
RUN apk add --no-cache openssl

# Copy package definitions
COPY package.json bun.lock* ./
RUN bun install

# Copy source code and Prisma schema
COPY . .

# Generate Prisma Client
RUN bun x prisma generate

# Expose server port
EXPOSE 5000

# Push DB schema, run seed, and start server
CMD ["sh", "-c", "bun x prisma db push && bun prisma/seed.ts && bun run start"]

