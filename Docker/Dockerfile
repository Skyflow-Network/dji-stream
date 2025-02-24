FROM ubuntu:latest as builder

RUN apt-get update && \
	apt-get install -y \
	git \
	wget \
	build-essential \
	ffmpeg \
	libpcre3 \
	libpcre3-dev \
	libssl-dev \
	zlib1g-dev

RUN git clone https://github.com/sergey-dryabzhinsky/nginx-rtmp-module.git

RUN wget https://nginx.org/download/nginx-1.27.4.tar.gz && \
	tar -xf nginx-1.27.4.tar.gz

RUN cd nginx-1.27.4 && \
	CFLAGS=-Wno-error ./configure --prefix=/usr/local/nginx --with-http_ssl_module --add-module=../nginx-rtmp-module && \
	CGLAGS=-Wno-error make -j 1 && \
	make install

FROM ubuntu:latest as runner

RUN apt-get update && \
	apt-get install -y \
	ffmpeg \
	libpcre3 \
	libssl-dev \
	zlib1g \
	curl \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/nginx /usr/local/nginx
COPY nginx.conf /usr/local/nginx/conf/nginx.conf

EXPOSE 80/tcp
EXPOSE 1935/tcp

STOPSIGNAL SIGQUIT

CMD ["/usr/local/nginx/sbin/nginx", "-g", "daemon off;"]
