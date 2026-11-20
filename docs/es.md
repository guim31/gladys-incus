# Incus

Esta integración lleva a Gladys los **contenedores y máquinas virtuales de un servidor Incus** (o LXD, misma API): un dispositivo por instancia elegida,
con su estado, su uso de procesador y memoria y su dirección IP, más un
dispositivo para el propio servidor. Un dispositivo instancia es un
interruptor: apáguelo para detener la instancia, enciéndalo para iniciarla.
Las escenas pueden reaccionar cuando una instancia se detiene sin que Gladys
lo pida, e iniciar, detener o reiniciar una instancia; un widget del panel
lista las instancias, los problemas primero.

Habla con la **API REST de Incus** por HTTPS en su red local, con su propio
certificado de cliente; nada pasa por la nube.

Desarrollada sin un servidor Incus real: sus comentarios son bienvenidos en
[las issues](https://github.com/guim31/gladys-incus/issues). La integración
se ha probado con respuestas calcadas de la API de Incus y contra un servidor
TLS local que comprueba los certificados de cliente como Incus, no contra un
Incus o LXD real, ni una instancia real de Gladys.

No confundir con Proxmox VE: sus contenedores LXC y VM los gestiona Proxmox,
mediante otra API (vea la integración Proxmox del store).

## Lo que necesita

- Gladys Assistant 5.1.0 o posterior.
- Un servidor Incus (6.0 o posterior) o LXD (5.21 o posterior), accesible
  desde la máquina de Gladys.
- Un terminal en ese servidor, una vez, para abrir la API a la red y crear
  un token de confianza.

## Puesta en marcha

### 1. Abrir la API a la red

Por defecto, Incus solo escucha en su socket Unix local. En el servidor:

```sh
incus config set core.https_address :8443
```

La API se sirve entonces por HTTPS en el puerto 8443. Abra este puerto solo
a la máquina de Gladys; no lo exponga nunca a Internet.

### 2. Crear un token de confianza

Incus solo responde a los clientes cuyo certificado conoce. La integración
crea su propio certificado en su primer arranque (guardado en su volumen
`/data`); un token permite que Incus confíe en él:

```sh
incus config trust add gladys
```

Copie la línea que muestra. Para mantener a Gladys lejos de algunas
instancias, restrinja el certificado a algunos proyectos:
`incus config trust add gladys --restricted --projects default`.
Con LXD, los mismos comandos empiezan por `lxc` en lugar de `incus`.

### 3. Configurar la integración

En Gladys, **Integraciones → Incus → Configuración**:

- **Dirección del servidor Incus**: `192.168.1.30` (puerto 8443 si se omite,
  `https://…` aceptado). Vacío: la primera dirección del token;
- **Token de confianza**: la línea copiada arriba. Se usa una vez: después
  Incus confía en el certificado de Gladys y el token queda consumido;
- **Nombre del servidor** (opcional): se muestra en el nombre del
  dispositivo, el widget y los mensajes;
- **Intervalo de actualización**: 30 segundos por defecto;
- **Idioma de los nombres**: el idioma de los nombres de las funciones y de
  los mensajes de las acciones.

**Probar la conexión** lee Incus y dice lo que ha encontrado.

El token lleva también la huella del certificado del servidor: Gladys la
comprueba en cada conexión, antes de enviar nada. Sin token, se conserva el
primer certificado visto. Si el servidor cambia de certificado (una
reinstalación), Gladys se niega a hablar con él; compruebe por qué y use
**Volver a confiar en el certificado**.

Sin token, también puede confiar en el certificado a mano: copie
`client.crt` desde el volumen `/data` de la integración en la máquina de
Gladys y ejecute `incus config trust add-certificate client.crt` en el
servidor.

### 4. Añadir los dispositivos

En la pestaña **Descubrir**, añada el servidor y las instancias que quiera
seguir. Una instancia se identifica por su **nombre** y su proyecto
(`proyecto/nombre` fuera del proyecto por defecto): reconstruida con el mismo
nombre, conserva su dispositivo y su historial.

## Los dispositivos

### El servidor

- **Accesible**: 1 mientras Incus responde;
- **Versión**: `Incus 6.18` o `LXD 5.21.3`;
- **Instancias en marcha**, **Instancias** (en total).

### Las instancias

- **En marcha**: un interruptor; apagado pide a la instancia que se apague
  correctamente (30 segundos como máximo), encendido la inicia (o la reanuda
  si está en pausa);
- **Procesador**: el uso del procesador desde la lectura anterior, en % de
  los hilos que la instancia puede usar (lo que Incus le asigna: `limits.cpu` y su cuota; una vCPU para una VM sin
  límite, todos los hilos del servidor para un contenedor);
- **Memoria**: la memoria usada, en MB;
- **Dirección IP**: la primera dirección IPv4 global (si no, IPv6). Una VM
  solo la indica con su agente (`incus-agent`) en marcha.

Una instancia detenida usa 0 % y 0 MB. Una instancia eliminada del servidor
aparece como inaccesible.

## Panel

El widget **Instancias de Incus** muestra las instancias en marcha sobre el
total, las que tienen error y la lista de instancias: las añadidas (todas si
no hay ninguna), los problemas primero, con su dirección IP. Elija una
instancia en sus ajustes para tener los botones **Iniciar** o **Detener** y
**Reiniciar**; **Actualizar** vuelve a leer Incus. La lista y cada botón se
pueden ocultar.

## Escenas

### Disparadores

- **Instancia detenida inesperadamente**: un contenedor o una VM en marcha se
  ha detenido o tiene un error sin que Gladys lo pida (fallo, apagado desde
  dentro, memoria, `incus stop` a mano). Una parada pedida por Gladys
  (interruptor, acción, widget, escena) no dispara nada; una pausa tampoco.
  Variables: instancia, proyecto, estado. Se puede limitar a un dispositivo
  instancia.
- **Incus inaccesible**: el servidor ya no responde (dos lecturas seguidas,
  con 15 segundos de intervalo); se anuncia una vez por corte.

### Acciones

- **Iniciar una instancia**, **Detener una instancia**, **Reiniciar una instancia**: la instancia se elige entre los dispositivos instancia; las
  salidas son su nombre y si funciona después. Las tres son también botones
  de la pantalla de configuración, junto a **Probar la conexión** y **Volver a confiar en el certificado**.

### Ideas de escenas

- Avisarme cuando el contenedor de la base de datos se detenga
  inesperadamente.
- Iniciar la VM del servidor de juegos cuando llegue a casa el viernes por la
  tarde, detenerla a medianoche.
- Reiniciar el contenedor del servidor multimedia cada noche a las 4.

## Solución de problemas

- **El servidor no responde**: compruebe `core.https_address`
  (`incus config get core.https_address`), el puerto y el cortafuegos.
- **Gladys aún no está autorizado**: pegue un token en la configuración
  (arriba).
- **Token de confianza rechazado**: ha caducado o ya se ha usado; cree uno
  nuevo.
- **El certificado del servidor ha cambiado**: tras una reinstalación, use
  **Volver a confiar en el certificado**; si no, compruebe que nada
  intercepta la conexión.
- **Incus lo ha rechazado: el certificado de Gladys está restringido**: el
  certificado está limitado a proyectos que no contienen esta instancia.
- **Una VM no tiene dirección IP**: inicie su agente (`incus-agent`).
- **Registros**: ponga `LOG_LEVEL=debug` en la integración para ver cada
  lectura.

## Límites

- Un servidor Incus por integración; en un clúster, los miembros se leen a
  través del servidor indicado.
- Ni instantáneas, ni migraciones, ni consolas, ni imágenes: solo estado,
  procesador, memoria, dirección, inicio, parada y reinicio.
- Una parada es siempre un apagado correcto (30 segundos como máximo): un
  invitado bloqueado no se fuerza.
- Sin relación con el proyecto Linux Containers, Incus ni Canonical (LXD).
