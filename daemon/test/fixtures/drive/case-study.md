# **Harbor: call analytics case study**

*Written for the Acme Voice engineering blog, 2024*

## **Context**

Harbor transcribes and scores sales calls for 40 customer teams. When I joined, a nightly batch job read every call again, and transcription cost was the largest line on the cloud bill.

## **What I built**

I designed the streaming pipeline that replaced the nightly batch: calls are chunked as they arrive, transcribed on spot instances and scored within five minutes of the call ending. I wrote the scoring API in Python and FastAPI.

Maria Petrou built the dashboards on top of the API.

## **Results**

* Transcription cost fell by 35% in the first quarter.
* Scores are ready 5 minutes after a call instead of the next morning.
