# Sleuth em contêiner. O navegador (Chromium) vem incluído; para uma imagem menor: --build-arg WITH_BROWSER=0
FROM node:24-slim
WORKDIR /app
ARG WITH_BROWSER=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && if [ "$WITH_BROWSER" = "1" ]; then npx playwright-core install --with-deps chromium && rm -rf /var/lib/apt/lists/*; fi
COPY launcher.js server.js ./
COPY src ./src
COPY ui ./ui
ENV NODE_ENV=production PORT=7002 DATA_DIR=/data HOME=/tmp BROWSER_IN_CONTAINER=1 SLEUTH_RESTART=1
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 7002
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "launcher.js"]
