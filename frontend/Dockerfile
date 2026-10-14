FROM public.ecr.aws/docker/library/node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM public.ecr.aws/nginx/nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
# nginx renders templates/*.template with envsubst at startup:
#   PORT          port to listen on (default 80)
#   API_UPSTREAM  backend host:port (default backend:8000; on Railway: backend.railway.internal:8000)
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
ENV PORT=80 API_UPSTREAM=backend:8000
EXPOSE 80
