# companion-module-wheatstone-wheatnet

See [HELP.md](./companion/HELP.md) and [LICENSE](./LICENSE)

## Getting started

Executing a `yarn` command should perform all necessary steps to develop the module, if it does not then follow the steps below.

The module can be built once with `yarn build`. This should be enough to get the module to be loadable by companion.

While developing the module, by using `yarn dev` the compiler will be run in watch mode to recompile the files on change.

## TCP Connection

Each Blade supports up to 20 simultaneous TCP connections (10 on a PC driver) from client PCs or other network devices.
The Blade acts as a TCP server for the connection. The PC acts as a TCP client for the connection. The Blade listens for TCP
connections on port 55776. All remote computers will make a TCP connection to the Blades with this one TCP port number.

The Blade will timeout and close a TCP connection if it does not have any activity for more than 120 seconds. Therefore, in
order to maintain your TCP connection your application MUST PERIODICALLY SEND A HEARTBEAT message of some
sort.
You could periodically request the version number of the console, which would result in a response being sent to your
application or you can send an empty message, if you want to periodically send heartbeats to keep the connection alive
without generating a response from the console. An empty message would be of the form:
<>
You should attempt to send the heartbeat more frequently than the 120 second timeout period. A 30 second heartbeat
message would be a good target rate to implement. Each of the up to 20 connections are independent, each requires its own
heartbeat activity.
