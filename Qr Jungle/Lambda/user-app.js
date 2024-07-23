import razorpay from 'razorpay';
import nodemailer from "nodemailer";
import { PassThrough } from 'stream';
/* ---------- SES IMPORTS ----------- */
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import sesClientModule from "@aws-sdk/client-ses";

/*----- EXTERNAL PODS IMPORTS -----*/
import { randomUUID } from 'crypto';

/* ---------- COGNITO IMPORTS ----------- */
import { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminSetUserPasswordCommand, AdminDeleteUserCommand, AdminGetUserCommand, InitiateAuthCommand, AdminDisableUserCommand, AdminEnableUserCommand } from "@aws-sdk/client-cognito-identity-provider";
const cognito_client = new CognitoIdentityProviderClient({ apiVersion: "2016-04-18" });

/* ---------- DYNAMO DB IMPORTS ----------- */
import ddb from "@aws-sdk/lib-dynamodb";
import * as dynamodb from "@aws-sdk/client-dynamodb";
const docClient = new dynamodb.DynamoDBClient();
const ddbDocClient = ddb.DynamoDBDocumentClient.from(docClient, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});
const { unmarshall, marshall } = await import("@aws-sdk/util-dynamodb");

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3_client = new S3Client({ region: "ap-south-1" });

import { v4 as uuidv4 } from 'uuid';

/* ---------- COGNITO API'S ----------- */
async function create_cognito_user(event) {
  try {
    console.log("Check Event!!!!!!!!!!!", JSON.stringify(event));
    const input = {
      UserPoolId: process.env.USER_POOL_ID,
      Username: event.user_email_id,
      UserAttributes: [{
          Name: "email",
          Value: event.user_email_id,
        },
        {
          Name: "email_verified",
          Value: "true",
        }
      ],
      TemporaryPassword: process.env.temp_pass,
      ForceAliasCreation: true,
      MessageAction: "SUPPRESS",
    };
    const command = new AdminCreateUserCommand(input);
    const response = await cognito_client.send(command);
    return response;
  }
  catch (error) {
    throw new Error(error);
  }
}

async function delete_cognito_user(event) {
  let params = {
    UserPoolId: process.env.USER_POOL_ID,
    Username: event.user_email_id,
  };
  try {
    let command = new AdminDeleteUserCommand(params);
    await cognito_client.send(command);
    return "Success";
  }
  catch (err) {
    console.log(params, err);
    throw new Error("ERROR IN DELETE!!!", err);
  }
}

async function create_cognito_user2(user_email_id, poolId, temp_pass, resendInvitation, suppress) {
  let params = {
    UserPoolId: poolId,
    Username: user_email_id.trim().toLowerCase(),
    UserAttributes: [{
        Name: "email",
        Value: user_email_id.trim().toLowerCase(),
      },
      {
        Name: "email_verified",
        Value: "true",
      },
    ],
    TemporaryPassword: temp_pass,
  };
  try {
    if (resendInvitation) {
      params.MessageAction = "RESEND";
    }
    if (suppress) {
      params.MessageAction = "SUPPRESS";
    }
    const command = new AdminCreateUserCommand(params);
    let response = await cognito_client.send(command);
    if (response.$metadata) {
      const setPasswordParams = {
        UserPoolId: poolId,
        Username: user_email_id.trim().toLowerCase(),
        Password: temp_pass,
        Permanent: true
      };
      const setPasswordCommand = new AdminSetUserPasswordCommand(setPasswordParams);
      let setPasswordResponse = await cognito_client.send(setPasswordCommand);
      if (setPasswordResponse.$metadata) {
        return {
          status: "SUCCESS",
          user_details: response.User,
        };
      }
      else {
        throw new Error("Can't Confirm Cognito User!!");
      }

    }
    else {
      throw new Error("Can't Create Cognito User!!")
    }
  }
  catch (err) {
    console.log(params, err);
    throw new Error(err);
  }
}


/* ---------- DYNAMO DB API'S ----------- */
const query_dynamo = async (params) => {
  try {
    let command = new ddb.QueryCommand(params);
    const data = await ddbDocClient.send(command);
    return data;
  }
  catch (err) {
    console.log(params, err);
    throw new Error(err);
  }
};

const scan_dynamo = async (params) => {
  try {
    let command = new ddb.ScanCommand(params);
    const data = await ddbDocClient.send(command);
    return data;
  }
  catch (err) {
    console.log(params, err);
    throw new Error(err);
  }
};

const insert_into_dynamo = async (params) => {
  try {
    let command = new ddb.PutCommand(params);
    await ddbDocClient.send(command);
    return "Success";
  }
  catch (err) {
    console.log(params, err);
    throw new Error(err);
  }
};

const update_dynamo = async (params) => {
  try {
    let command = new ddb.UpdateCommand(params);
    await ddbDocClient.send(command);
    return "Success";
  }
  catch (err) {
    console.log(params, err);
    throw new Error(err);
  }
};

const delete_dynamo = async (params) => {
  try {
    let command = new ddb.DeleteCommand(params);
    await ddbDocClient.send(command);
    return "Success";
  }
  catch (err) {
    console.log(params, err);
    throw new Error(err);
  }
};

const query_all_dynamo = async (params) => {
  try {
    let data = { Items: [], Count: 0 };
    const query_dynamo = async (table_params) => {
      let command = new ddb.QueryCommand(params);
      let table_data = await ddbDocClient.send(command);
      data.Count += table_data.Count;
      data.Items = data.Items.concat(table_data.Items);
      if (table_data.LastEvaluatedKey != undefined || table_data.LastEvaluatedKey != null) {
        table_params.ExclusiveStartKey = table_data.LastEvaluatedKey;
        return await query_dynamo(table_params);
      }
      else {
        return data;
      }
    };
    return await query_dynamo(params);
  }
  catch (err) {
    console.log(params, err);
    throw new Error(err);
  }
};

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

const batch_get_dynamo = async (params, table_name, retryCount = 0) => {
  try {
    let command = new dynamodb.BatchGetItemCommand(params);
    let res = await ddbDocClient.send(command);
    if (res.UnprocessedItems && res.UnprocessedItems.length > 0) {
      console.log(`$ { res.UnprocessedItems.length } unprocessed item(s) left, retrying...`);
      if (retryCount > 2) {
        throw new Error("UnprocessedItems", res.UnprocessedItems);
      }
      await wait(2 ** retryCount * 10);
      return batch_get_dynamo(res.UnprocessedItems, retryCount + 1);
    }
    let response_array = res.Responses[table_name];
    let response = {
      Items: [],
      Count: 0,
    };
    response_array.map((item) => {
      response.Items.push(unmarshall(item));
      response.Count++;
      return item;
    });
    return response;
  }
  catch (err) {
    console.log(params, err);
    throw new Error(err);
  }
};

const batch_delete_dynamo = async (params, retryCount = 0) => {
  try {
    let command = new dynamodb.BatchWriteCommand(params);
    let response = await ddbDocClient.send(command);
    console.log("response", response);
    if (response.UnprocessedItems && response.UnprocessedItems.length > 0) {
      console.log(`$ { response.UnprocessedItems.length } unprocessed item(s) left, retrying...`);
      if (retryCount > 2) {
        throw new Error(response.UnprocessedItems);
      }
      await wait(2 ** retryCount * 10);
      return batch_delete_dynamo(response.UnprocessedItems, retryCount + 1);
    }
    return "Success";
  }
  catch (err) {
    console.log(JSON.stringify(params), err);
    throw new Error(err);
  }
};

const batch_insert_dynamo = async (params, retryCount = 0) => {
  try {
    let command = new ddb.BatchWriteCommand(params);
    let response = await ddbDocClient.send(command);
    console.log("response", response);
    if (response.UnprocessedItems && response.UnprocessedItems.length > 0) {
      console.log(`$ { response.UnprocessedItems.length } unprocessed item(s) left, retrying...`);
      if (retryCount > 2) {
        throw new Error(response.UnprocessedItems);
      }
      await wait(2 ** retryCount * 10);
      return batch_insert_dynamo(response.UnprocessedItems, retryCount + 1);
    }
    return "Success";
  }
  catch (err) {
    console.log(JSON.stringify(params), err);
    throw new Error(err);
  }
};

/************INVOKE LAMBDA*****************/
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

export const invokeLambda = async (funcName, event_type) => {
  const command = new InvokeCommand({
    FunctionName: funcName,
    // Payload: payload,
    InvocationType: event_type, //'RequestResponse', // "Event"
  });
  await new LambdaClient().send(command);
  return 'SUCCESS';
};

/****************************USER MANAGEMENT*********************************/

const empty_fields_occured = (event) => {
  let output = true;
  for (const property in event) {
    if (typeof event[property] == "string") {
      if (event[property].length == 0) {
        output = false;
      }
    }
  }
  return output;
};

async function get_current_user_details(event) {
  console.log("GET------>", event)
  if (empty_fields_occured(event)) {
    let getUserDetailsParams = {
      TableName: "your_table_name",
      KeyConditionExpression: "id = :id",
      ExpressionAttributeValues: {
        ":id": event.cognito_email.username,
      },
    };
    let user = await query_dynamo(getUserDetailsParams);
    if (user.Count > 0) {
      let response = {};
      delete user.Items[0].id;
      response.items = user.Items;
      return { status: "Success", data: response };
    }
    else {
      throw new Error(`User  not found`);
    }
  }
  else {
    throw new Error("Empty fields occured");
  }
}


async function send_ses_email(event) {
  console.log("event of send ses email--->", event);
  const sesClient = new SESClient({
    region: "us-east-1"
  });

  let params = {
    Source: "no-reply@qrjungle.com",
    Destination: {
      ToAddresses: [event.user_email_id]
    },
    Message: {
      Subject: {
        Data: 'Welcome to QR Jungle!',
      },
      Body: {
        Html: {
          Data: `
            <!DOCTYPE html>
            <html>
            <head>
              <style>
                body {
                  font-family: Arial, sans-serif;
                  margin: 0;
                  padding: 0;
                  background-color: #f4f4f4;
                }
                .container {
                  width: 100%;
                  max-width: 600px;
                  margin: 0 auto;
                  background-color: #ffffff;
                  padding: 20px;
                  border-radius: 10px;
                  box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
                }
                .header {
                  background-color: #4CAF50;
                  color: white;
                  padding: 10px 0;
                  text-align: center;
                  border-radius: 10px 10px 0 0;
                }
                .content {
                  padding: 20px;
                }
                .footer {
                  background-color: #4CAF50;
                  color: white;
                  text-align: center;
                  padding: 10px 0;
                  border-radius: 0 0 10px 10px;
                }
                h1 {
                  color: #333;
                }
                p {
                  color: #666;
                }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="header">
                  <h1>Welcome to QR Jungle!</h1>
                </div>
                <div class="content">
                  <p>Dear ${event.user_name},</p>
                  <p>Welcome to <strong>QR Jungle</strong>. This is the place to find and buy all cool QR codes.</p>
                </div>
                <div class="footer">
                  <p style="color: #ffffff;">Thank you for joining us!</p>
                </div>
              </div>
            </body>
            </html>
          `,
        },
      },
    },
  };

  const sendEmailCommand = new SendEmailCommand(params);

  try {
    const response = await sesClient.send(sendEmailCommand);
    return 'SUCCESS!!';
  }
  catch (error) {
    console.error("Error sending email:", error);
    throw error;
  }
}

async function user_signup(event) {
  console.log("User-signup------------->", JSON.stringify(event));
  try {
    if (empty_fields_occured(event)) {
      const checkUserAlreadyExistsParams = {
        TableName: "your_table_name",
        IndexName: "user_email_id-index",
        KeyConditionExpression: "user_email_id = :user_email_id",
        ExpressionAttributeValues: {
          ":user_email_id": event.user_email_id.trim().toLowerCase()
        },
      };

      let userDetails = await query_dynamo(checkUserAlreadyExistsParams);

      if (userDetails.Items.length == 0) {
        const cognito_user = await create_cognito_user2(event.user_email_id, process.env.poolId, "061628", false, true);
        console.log("Cognito user created successfully.", cognito_user.Username);
        // const res = await send_ses_email(event);
        // console.log("Email sending response:", res);

        // if (res === "SUCCESS!!") {
        let userParams = {
          UserPoolId: process.env.poolId,
          Username: event.user_email_id.toLowerCase().trim(),
        };

        let cognito_data = await cognito_client.send(new AdminGetUserCommand(userParams));
        console.log("cognito_user", cognito_user);
        const createUserParams = {
          TableName: "your_table_name",
          Item: {
            "id": cognito_data.Username,
            "user_name": event.user_name,
            "user_email_id": event.user_email_id.trim().toLowerCase(),
            "user_created_on": Date.now(),
            "user_status": "ACTIVE",
          },
        };
        await insert_into_dynamo(createUserParams);
        const fireMail = await send_ses_email(event);
        if (fireMail == 'SUCCESS!!') {
          const updateParams = {
            TableName: "qrjungle_raydeo_reports",
            Key: {
              "report_id": "DO_NOT_DELETE_123"
            },
            UpdateExpression: "ADD total_users :total_users",
            ExpressionAttributeValues: {
              ":total_users": 1
            }
          }
          await update_dynamo(updateParams);
          await invokeLambda("qrjungle_raydeo_publish", "Event");
        }
        return { data: { status: 200, status_message: "User created Successfully!" } }
        // }
      }
      else {
        return { data: { status: 400, status_message: "Failed to create user.User already exists with the provided email." } }
        // console.log("User already exists with the provided email.");
      }
    }
    else {
      console.log("Empty fields occurred in the event.");
    }
  }
  catch (error) {
    console.error("Error in user signup process:", error);
  }
}

async function list_categories(event) {
  try {
    let listUserParams = {
      TableName: "your_table_name",
      Limit: 50
    };
    if (event.next_token) {
      listUserParams.ExclusiveStartKey = JSON.parse(Buffer.from(event.next_token.trim(), "base64").toString("ascii"));
    }
    let category = await scan_dynamo(listUserParams);
    if (category.Count > 0) {
      let response = {};
      response.items = category.Items.sort((a, b) => b.category_created_on - a.category_created_on);
      if (category.LastEvaluatedKey) {
        response.next_token = Buffer.from(JSON.stringify(category.LastEvaluatedKey)).toString("base64");
      }
      return { status: "Success", data: response };
    }
  }
  catch (err) {
    return { status_message: "Error occured on the server-side" };
  }
}


async function update_favourites(event) {
  const userExistsParam = {
    TableName: "your_table_name",
    KeyConditionExpression: "id= :id",
    ExpressionAttributeValues: {
      ":id": event.cognito_email.username
    }
  }
  const userDetails = await query_dynamo(userExistsParam);
  if (userDetails.Count > 0) {
    const updateParams = {
      TableName: "your_table_name",
      Key: {
        "id": userDetails.Items[0].id
      },
      UpdateExpression: "SET favourites= :favourites",
      ExpressionAttributeValues: {
        ":favourites": JSON.parse(event.favourites)
      }
    }
    const updation = await update_dynamo(updateParams);
    if (updation === "Success") {
      return { status: 200, status_message: "Updated successfully!" };
    }
    else {
      return { status: 400, status_message: "Bad request!" }
    }
  }
  else {
    return { status: 500, status_message: "Internal server error!" }
  }
}


// async function list_my_favourites(event) {
//   console.log("LIST------------>", event)
//   const userExistsParam = {
//     TableName: "your_table_name",
//     KeyConditionExpression: "id= :id",
//     ExpressionAttributeValues: {
//       ":id": event.cognito_email.username
//     }
//   }
//   const userDetails = await query_dynamo(userExistsParam);
//   for (let i = 0; i < userDetails.Items[0].favourites.length; i++) {
//     const listUsersFavQrsParams = {
//       TableName: "your_table_name",
//       KeyConditionExpression: "qr_code_id= :qr_code_id",
//       ExpressionAttributeValues: {
//         ":qr_code_id": userDetails.Items[0].favourites[i]
//       }
//     }
//     const qrList = await query_dynamo(listUsersFavQrsParams);
//     return qrList.Items;
//   }
// }


async function list_my_favourites(event) {
  console.log("LIST------------>", event);

  const userExistsParam = {
    TableName: "your_table_name",
    KeyConditionExpression: "id = :id",
    ExpressionAttributeValues: {
      ":id": event.cognito_email.username
    }
  };

  const userDetails = await query_dynamo(userExistsParam);

  if (userDetails.Items.length === 0) {
    return { status: 401, status_message: "Unauthorized exception!" };
  }

  const favourites = userDetails.Items[0].favourites;
  const favDetailsPromises = favourites.map(favouriteId => {
    const listUsersFavQrsParams = {
      TableName: "your_table_name",
      KeyConditionExpression: "qr_code_id = :qr_code_id",
      ExpressionAttributeValues: {
        ":qr_code_id": favouriteId
      }
    };
    return query_dynamo(listUsersFavQrsParams);
  });

  const favDetailsResults = await Promise.all(favDetailsPromises);
  const favDetails = favDetailsResults.flatMap(result => result.Items);
  return { data: favDetails, totalCount: favDetails.Count };
}


async function purchase_qr(event) {
  console.log("Purchase--->", event);

  const userExistsParam = {
    TableName: "your_table_name",
    KeyConditionExpression: "id = :id",
    ExpressionAttributeValues: {
      ":id": event.cognito_email.username
    }
  };
  const userDetails = await query_dynamo(userExistsParam);
  if (userDetails.Count == 0) {
    return { status: 401, status_message: "Unauthorized exception!" };
  }

  const qrExistsParam = {
    TableName: "your_table_name",
    KeyConditionExpression: "qr_code_id = :qr_code_id",
    ExpressionAttributeValues: {
      ":qr_code_id": event.qr_code_id
    }
  };
  const qrDetails = await query_dynamo(qrExistsParam);
  if (qrDetails.Count === 0 || qrDetails.Items[0].qr_code_status !== "APPROVED") {
    return { status: 400, status_message: "This is not eligible for purchase at the moment!" };
  }

  const purchaseParams = {
    TableName: "qrjungle_transactions",
    Item: {
      transaction_id: uuidv4(),
      qr_code_id: qrDetails.Items[0].qr_code_id,
      id: userDetails.Items[0].id,
      purchased_on: Date.now(),
      purchased_by: userDetails.Items[0].user_email_id,
      transaction_status: "SUCCESS",
      price: event.price,
      utr_no: event.utr_no,
      redirect_url: event.redirect_url
    }
  };
  const purchaseDetails = await insert_into_dynamo(purchaseParams);
  console.log("Purchase success", purchaseDetails);
  if (purchaseDetails === "Success") {
    const updateQrStatus = {
      TableName: "your_table_name",
      Key: {
        "qr_code_id": qrDetails.Items[0].qr_code_id
      },
      UpdateExpression: "SET qr_code_status = :qr_code_status, bought_by = :bought_by, redirect_url= :redirect_url",
      ExpressionAttributeValues: {
        ":qr_code_status": "PURCHASED",
        ":bought_by": userDetails.Items[0].id,
        ":redirect_url": event.redirect_url
      }
    };
    const qrUpdation = await update_dynamo(updateQrStatus);
    if (qrUpdation === "Success") {
      const userId = userDetails.Items[0].id;

      // Initialize my_qrs if it doesn't exist
      const initMyQrParams = {
        TableName: "your_table_name",
        Key: { "id": userId },
        UpdateExpression: "SET my_qrs = if_not_exists(my_qrs, :empty_list)",
        ExpressionAttributeValues: {
          ":empty_list": []
        }
      };
      await update_dynamo(initMyQrParams);

      // Append to my_qrs list
      const updateMyQrParams = {
        TableName: "your_table_name",
        Key: { "id": userId },
        UpdateExpression: "SET my_qrs = list_append(my_qrs, :my_qrs)",
        ExpressionAttributeValues: {
          ":my_qrs": [event.qr_code_id]
        }
      };
      const updation = await update_dynamo(updateMyQrParams);
      // console.log("UPdated---->", updation);
      const removal = await removePurchasedQrCodeFromFavourites(event.qr_code_id);
      // console.log("Removal-------->", removal);
      await sendMail(userDetails.Items[0].user_email_id, qrDetails.Items[0].qr_code_id);
      const updateParams = {
        TableName: "qrjungle_raydeo_reports",
        Key: {
          "report_id": "DO_NOT_DELETE_123"
        },
        UpdateExpression: "ADD bought_qrs :bought_qrs",
        ExpressionAttributeValues: {
          ":bought_qrs": 1
        }
      }
      await update_dynamo(updateParams);
      await invokeLambda("qrjungle_raydeo_publish", "Event");
      return { status: 200, status_message: "Purchase successful!" };
    }
    else {
      return { status: 500, status_message: "Failed to update QR code status." };
    }
  }
  else {
    return { status: 500, status_message: "Failed to record transaction." };
  }
}


async function removePurchasedQrCodeFromFavourites(qrCodeId) {
  // console.log("Params------>", qrCodeId);
  let params = {
    TableName: "your_table_name"
  };

  let scanResults = [];
  let items;

  do {
    items = await scan_dynamo(params);
    items.Items.forEach(item => scanResults.push(item));
    params.ExclusiveStartKey = items.LastEvaluatedKey;
  } while (typeof items.LastEvaluatedKey != "undefined");

  for (let user of scanResults) {
    if (user.favourites && user.favourites.includes(qrCodeId)) {
      const updatedFavourites = user.favourites.filter(code => code !== qrCodeId);
      // console.log('Updated favourites-------->', updatedFavourites);
      const updateParams = {
        TableName: "your_table_name",
        Key: { id: user.id },
        UpdateExpression: 'set favourites = :favs',
        ExpressionAttributeValues: {
          ':favs': updatedFavourites
        }
      };

      const updation = await update_dynamo(updateParams);
      // console.log("Updation------->", updation);
    }
  }
}
removePurchasedQrCodeFromFavourites().then(() => {
  console.log('Purchased QR code removed from all users\' favourites');
}).catch(error => {
  console.error('Error removing purchased QR code:', error);
});



async function list_my_qrs(event) {
  const userExistsParam = {
    TableName: "your_table_name",
    KeyConditionExpression: "id = :id",
    ExpressionAttributeValues: {
      ":id": event.cognito_email.username
    }
  };

  const userDetails = await query_dynamo(userExistsParam);

  if (userDetails.Items.length === 0) {
    return { status: 401, status_message: "Unauthorized exception!" };
  }
  const listQrParam = {
    TableName: "your_table_name",
    IndexName: "bought_by-index",
    KeyConditionExpression: "bought_by= :bought_by",
    ExpressionAttributeValues: {
      ":bought_by": userDetails.Items[0].id
    }
  }
  const result = await query_dynamo(listQrParam);
  if (result.Count > 0) {
    return result.Items;
  }
  else {
    return { status: 404, status_message: "First, you need to buy it lol!" }
  }
}


async function create_order(event) {
  console.log("ORDER-------->", event)
  let instance = new razorpay({ key_id: process.env.key_id, key_secret: process.env.key_secret });

  const options = {
    amount: event.amount,
    currency: event.currency
  };
  try {
    const order = await instance.orders.create(options);
    console.log(order);
    return order;
  }
  catch (err) {
    console.error(err);
    throw err;
  }
}


async function edit_redirect_url(event) {
  console.log("EVENT", event)
  const userExistsParam = {
    TableName: "your_table_name",
    KeyConditionExpression: "id = :id",
    ExpressionAttributeValues: {
      ":id": event.cognito_email.username
    }
  };
  const userDetails = await query_dynamo(userExistsParam);
  if (userDetails.Count > 0) {
    const checkQrExists = {
      TableName: "your_table_name",
      KeyConditionExpression: "qr_code_id= :qr_code_id",
      ExpressionAttributeValues: {
        ":qr_code_id": event.qr_code_id
      }
    }
    const qrDetails = await query_dynamo(checkQrExists);
    if (qrDetails.Items[0].bought_by == userDetails.Items[0].id) {
      const editQrRedirectUrlParams = {
        TableName: "your_table_name",
        Key: {
          qr_code_id: qrDetails.Items[0].qr_code_id
        },
        UpdateExpression: "SET redirect_url= :redirect_url",
        ExpressionAttributeValues: {
          ":redirect_url": event.redirect_url
        }
      }
      await update_dynamo(editQrRedirectUrlParams);
      return { status: 200, status_message: "Updated successfully!" }
    }
    else {
      return { status: 401, status_message: "QR code does not belong to you!" }
    }
  }
  else {
    return { status: 404, status_message: "User not found!" }
  }
}

const downloadFile = async (file_key) => {
  const command = new GetObjectCommand({
    Bucket: "qrjungle-all-qrcodes",
    Key: file_key
  });

  const response = await s3_client.send(command);
  const stream = response.Body.pipe(new PassThrough());
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);

  return {
    filename: file_key,
    content: buffer,
    contentType: 'image/png'
  };
};


const sendMail = async (user_email_id, qr_code_id) => {
  const ses = new sesClientModule.SESClient({ region: "us-east-1" })
  const transporter = nodemailer.createTransport({
    SES: { ses, aws: sesClientModule },
  });

  const file_key = `${qr_code_id}.png`;

  const attachment = await downloadFile(file_key);

  const mailOptions = {
    from: "no-reply@qrjungle.com",
    to: user_email_id,
    subject: "Your QR Code Purchase Confirmation",
    text: "Please find the attached QR code.",
    html: `
    <html>
      <body style="font-family: Arial, sans-serif; line-height: 1.6;">
        <h2>Thank You for Your Purchase!</h2>
        <p>Dear Valued Customer,</p>
        <p>Thank you for your purchase! We are excited to provide you with your new QR code. Please find the QR code attached to this email.</p>
        <p>If you have any questions or need further assistance, please do not hesitate to contact our support team at support@qrjungle.com.</p>
        <p>Best regards,</p>
        <p>The QR Jungle Team</p>
      </body>
    </html>
  `,
    attachments: [attachment],
  };


  try {
    const info = await transporter.sendMail(mailOptions);
    // console.log("Email sent successfully:");
    // console.log("Message ID:", info.messageId);
    // console.log("Response:", info.response);
  }
  catch (err) {
    console.error("Error sending email:", err);
  }
};


async function list_my_private_categories(event) {
  console.log("EVENT", event);

  let getUserDetailsParams = {
    TableName: "your_table_name",
    KeyConditionExpression: "id = :id",
    ExpressionAttributeValues: {
      ":id": event.cognito_email.username,
    },
  };

  try {
    const userDetails = await query_dynamo(getUserDetailsParams);
    // console.log("USER DETAILS", userDetails);

    if (userDetails.Count > 0) {
      const user_email_id = userDetails.Items[0].user_email_id;
      const checkMyVisibilityParams = {
        TableName: "your_table_name",
        IndexName: "user_email_id-index",
        KeyConditionExpression: "user_email_id= :user_email_id",
        ExpressionAttributeValues: {
          ":user_email_id": user_email_id
        },
      };

      const result = await query_dynamo(checkMyVisibilityParams);
      // console.log("PRIVATE CATEGORIES", result.Items[0].category_name);
      if (result.Count == 0) {
        return { status: 404, status_message: "No items found!" }
      }
      return {
        status: 200,
        data: result.Items
      };
    }
    else {
      return {
        status: 404,
        message: "User not found"
      };
    }
  }
  catch (error) {
    return {
      status: 500,
      message: "Internal Server Error"
    };
  }
}


async function update_redeemable(event) {
  const input = {
    TableName: "your_table_name",
    Key: {
      id: event.cognito_email.username
    },
    UpdateExpression: "SET redeem_count= :redeem_count",
    ExpressionAttributeValues: {
      ":redeem_count": event.redeem_count
    }
  }
  await update_dynamo(input);
  return { status: 200, status_message: "Updated successfully" }
}

async function request_customization(event) {
  console.log("EVENT-------->", event)
  const checkUserAlreadyExistsParams = {
    TableName: "your_table_name",
    KeyConditionExpression: "id= :id",
    ExpressionAttributeValues: {
      ":id": event.cognito_email.username
    }
  }
  const userDetails = await query_dynamo(checkUserAlreadyExistsParams);
  if (userDetails.Count > 0) {
    const createRequestParams = {
      TableName: "your_table_name",
      Item: {
        request_id: randomUUID(),
        user_email_id: userDetails.Items[0].user_email_id,
        user_phone_number: event.user_phone_number,
        details: event.details,
      }
    }
    await insert_into_dynamo(createRequestParams);
    return { status: 200, status_message: "Request successful!" };
  }
  else {
    return { status: 404, status_message: "User not found!" }
  }
}


export const handler = async (event) => {
  switch (event.command) {

    case "getCurrentUserDetails":
      return await get_current_user_details(event);

    case "userSignUp":
      return await user_signup(event);

    case "listCategories":
      return await list_categories(event);

    case 'updateFavourites':
      return await update_favourites(event);

    case 'listMyFavourites':
      return await list_my_favourites(event);

    case 'puchaseQr':
      return await purchase_qr(event);

    case 'listMyQrs':
      return await list_my_qrs(event);

    case 'createOrder':
      return await create_order(event);

    case 'editRedirectUrl':
      return await edit_redirect_url(event);

    case 'listMyPrivateCategories':
      return await list_my_private_categories(event)

    case 'updateRedeemable':
      return await update_redeemable(event);

    case 'requestCustomization':
      return await request_customization(event);

    default:
      return "Command not found!";
  }
}
