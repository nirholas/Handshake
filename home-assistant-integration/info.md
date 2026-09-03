# three.ws

Put a 3D agent with a voice in front of your house.

This integration is for a Home Assistant that only exists on your own network. Your house opens
one outgoing connection to three.ws and keeps it: nothing listens on your network, no port is
forwarded, and **three.ws never receives a Home Assistant token**.

After installing, restart Home Assistant, then **Settings, Devices and services, Add integration,
three.ws**, and paste the pairing code from [three.ws/smart-home](https://three.ws/smart-home).

What three.ws can do through this is fixed by an allowlist enforced on your own machine: reads,
your room and area layout, and device service calls. It can never run code on this machine,
restart or reconfigure Home Assistant, or reach anything else on your network. Anything that
unlocks, opens or disarms stops and asks a person first, every time.

Full detail, including an honest threat model, is in the README.
