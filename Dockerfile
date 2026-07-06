# LeylineSync — one image for both services:
#   web: npm run start   (Next.js SSR)
#   bot: npm run bot     (bot-runner, needs dev deps for tsx)
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# NEXT_PUBLIC_* vars are inlined into the client bundle at BUILD time,
# so they must be present here — runtime env alone is not enough.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_SHOW_DEV_CONTROLS=false
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY \
    NEXT_PUBLIC_SHOW_DEV_CONTROLS=$NEXT_PUBLIC_SHOW_DEV_CONTROLS

RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "run", "start"]
